"""The porchd service: state, policy execution, and the API's business half.

`server.py` owns HTTP; everything it can answer lives here, so the wire
semantics of §4/§7/§8 are testable without a socket.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from pathlib import Path

from porch3 import drstore
from porch3.config import PorchConfig
from porch3.constants import CHANNEL_POLL_S, FALLBACK_PALETTE, POLL_S
from porch3.mentions import registered_rooms
from porch3.presence import fetch_presence
from porch3.sanitize import sanitize_display
from porch3.send import SendResult, send_as_owner
from porch3.signer import Signer
from porch3.store import (
    channel_description,
    channel_members,
    channel_preview,
    discover_channels,
    index_by_id,
    join_channel,
    load_all,
    load_new,
)
from porch3.theme import SenderTheme
from porch3.verify import enqueue_verifications
from porchd import config as config_mod
from porchd import imagesvc, lease, ledger, policy, postcli, render, tokens
from porchd.oplock import OperationBusy, operation_lock
from porchd.ownership import LiveVerifier
from porchd.state import ensure_root

# Auto-join is leased on client activity (§1): a persistent service must not
# turn "join while porch is open" into permanent ambient identity mutation.
ACTIVITY_LEASE_S = 3 * POLL_S
DELIVERY_TOKEN_TTL_S = 300.0
BOUNCE_TOKEN_TTL_S = 600.0
MESSAGE_PAGE_LIMIT = 500
# A send waits this long for the operation queue before refusing, so a
# passphrase prompt left open at the terminal cannot hang the phone.
OPERATION_TIMEOUT_S = 30.0


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra

    def payload(self) -> dict:
        return {"ok": False, "error": {"code": self.code, "message": self.message, **self.extra}}


class Service:
    def __init__(
        self,
        root: Path | None = None,
        *,
        porch_config: PorchConfig,
        channels_root: Path | None = None,
        config: config_mod.Config | None = None,
        spool_dir: Path | None = None,
    ):
        self.root = ensure_root(root)
        self.porch_config = porch_config
        self.channels_root = channels_root or porch_config.channels_dir
        self.config = config if config is not None else config_mod.load(self.root)
        self.spool_dir = spool_dir
        self.theme = SenderTheme()
        self.verifier = LiveVerifier(
            channels_root=self.channels_root,
            mail_root=porch_config.mail_root,
            wire=porch_config.wire,
            porch_config=porch_config,
            config_path=getattr(porch_config, "source_path", None),
        )
        self.agent = lease.Agent(self.root)

        self._store_lock = threading.RLock()
        self._send_lock = threading.RLock()
        self._cache: dict[str, dict] = {}
        self._known_channels: set[str] = set()
        self._channels: list[str] = []
        self._presence: dict[str, bool] = {}
        self._dr_records: dict[str, dict] = {}
        self._last_activity = 0.0
        self._stop = threading.Event()
        self._poller: threading.Thread | None = None

    # ---- lifecycle -----------------------------------------------------

    def start(self, *, with_agent: bool = True, with_poller: bool = True) -> None:
        from porch3.roomcheck import apply_owner_crosscheck, assert_acting_room
        from porch3.verify import set_trust_context

        assert_acting_room(self.porch_config)
        self.porch_config = apply_owner_crosscheck(self.porch_config)
        set_trust_context(self.porch_config)
        # LiveVerifier may have been constructed before crosscheck; refresh pin.
        self.verifier.porch_config = self.porch_config
        self.verifier.config_path = self.porch_config.source_path
        self.verifier.wire = self.porch_config.wire
        self.verifier.mail_root = self.porch_config.mail_root
        ledger.prune(self.root)
        imagesvc.prune_uploads(self.root, spool_dir=self.spool_dir)
        if with_agent:
            self.agent.start()
        self.refresh_channels(join=False)
        self.reload_dr()
        if with_poller:
            self._poller = threading.Thread(target=self._poll_loop, name="porchd-poll", daemon=True)
            self._poller.start()

    def stop(self) -> None:
        self._stop.set()
        self.agent.stop()

    def _poll_loop(self) -> None:
        while not self._stop.wait(CHANNEL_POLL_S):
            try:
                self.refresh_channels(join=self.activity_leased())
                self._presence = fetch_presence(config=self.porch_config)
            except Exception:  # a poll must never take the service down
                continue

    # ---- activity lease ------------------------------------------------

    def note_activity(self) -> None:
        self._last_activity = time.time()

    def activity_leased(self) -> bool:
        return (time.time() - self._last_activity) <= ACTIVITY_LEASE_S

    # ---- channels and messages ----------------------------------------

    def refresh_channels(self, *, join: bool) -> list[str]:
        channels = discover_channels(self.channels_root)
        with self._store_lock:
            self._channels = channels
            if join:
                for channel in channels:
                    if channel in self._known_channels:
                        continue
                    if join_channel(channel, config=self.porch_config):
                        self._known_channels.add(channel)
            else:
                # Read-only discovery: seen, never joined.
                self._known_channels.update(c for c in channels if c in self._known_channels)
        return channels

    def known_channel(self, channel: str) -> str:
        """Match a channel name against discovered channels — never a path join."""
        if not isinstance(channel, str) or not channel:
            raise ApiError("no_such_channel", "unknown channel", 404)
        with self._store_lock:
            channels = self._channels or discover_channels(self.channels_root)
            self._channels = channels
        if channel not in channels:
            raise ApiError("no_such_channel", "unknown channel", 404)
        return channel

    def _bucket(self, channel: str) -> dict:
        bucket = self._cache.get(channel)
        if bucket is None:
            msgs = load_all(channel, self.channels_root)
            bucket = {"msgs": msgs, "seen": {m["id"] for m in msgs}}
            self._cache[channel] = bucket
            self._absorb(channel, msgs)
        return bucket

    def _absorb(self, channel: str, fresh: list[dict]) -> None:
        if not fresh:
            return
        enqueue_verifications(fresh, wire=self.porch_config.wire)
        self.verifier.consider(channel, fresh)
        self._observe_dr_actions(fresh)

    def messages(self, channel: str) -> list[dict]:
        with self._store_lock:
            bucket = self._bucket(channel)
            fresh = load_new(channel, bucket["seen"], self.channels_root)
            if fresh:
                bucket["msgs"].extend(fresh)
                bucket["msgs"].sort(key=lambda m: m["id"])
                bucket["seen"].update(m["id"] for m in fresh)
                self._absorb(channel, fresh)
            return list(bucket["msgs"])

    # ---- decision records ---------------------------------------------

    def reload_dr(self) -> dict[str, dict]:
        try:
            pc = self.porch_config
            self._dr_records = drstore.project(
                drstore.replay(pc.dr_log_path),
                mail_root=pc.mail_root,
                wire=pc.wire,
                config=pc,
                config_path=pc.source_path,
                principal=pc.principal,
                namespace=pc.signing_namespace,
                allowed_signers=pc.allowed_signers,
                owner_room=pc.owner_room,
                sigs_dir=pc.sigs_dir,
            )
        except Exception:
            self._dr_records = {}
        return self._dr_records

    def _observe_dr_actions(self, fresh: list[dict]) -> None:
        """The owner's signed action message IS the authority instrument.

        Mirrors the TUI: a full-body anchored parse, deduped per actor
        message id, with projection re-verifying the signature — so a
        spoofed `from: <owner_room>` changes nothing durable.
        """
        appended = False
        events = None
        for msg in fresh:
            if msg.get("from") != self.porch_config.owner_room:
                continue
            parsed = drstore.parse_observed_action(
                msg,
                owner_room=self.porch_config.owner_room,
                wire=self.porch_config.wire,
            )
            if parsed is None:
                continue
            dr, verb, new_dr = parsed
            record = self._dr_records.get(dr)
            if record is None:
                continue
            if verb != "superseded" and record["state"] != "needs_operator_decision":
                continue
            if events is None:
                events = drstore.replay(self.porch_config.dr_log_path)
            if drstore.has_actor_event(events, msg["id"]):
                continue
            try:
                if verb == "superseded":
                    if new_dr in self._dr_records:
                        drstore.supersede(
                            dr, new_dr, msg["id"], self.porch_config.dr_log_path
                        )
                        appended = True
                else:
                    drstore.decide(
                        dr,
                        "ratified" if verb == "accepted" else "rejected",
                        msg["id"],
                        self.porch_config.dr_log_path,
                    )
                    appended = True
            except (OSError, ValueError):
                continue
        if appended:
            self.reload_dr()

    # ---- read endpoints ------------------------------------------------

    def own_ids(self) -> set[str]:
        return ledger.committed_message_ids(self.root)

    def bootstrap(self, device: str) -> dict:
        channels = self.refresh_channels(join=self.activity_leased())
        presence = self._presence or fetch_presence(config=self.porch_config)
        self._presence = presence
        rooms = registered_rooms(self.porch_config)
        entries = []
        for channel in channels:
            members = channel_members(channel, self.channels_root)
            when, who, preview = channel_preview(channel, self.channels_root)
            entries.append(
                {
                    "name": sanitize_display(channel),
                    "description": channel_description(channel, self.channels_root),
                    "members": [
                        {"room": sanitize_display(m), "live": bool(presence.get(m))}
                        for m in members
                    ],
                    "live": any(presence.get(m) for m in members),
                    "last_time": when,
                    "last_from": who,
                    "preview": preview,
                }
            )
        colors = {room: self.theme.color(room) for room in sorted(rooms)}
        for entry in entries:
            colors.setdefault(entry["last_from"], self.theme.color(entry["last_from"]))
        # owner_accent is authoritative for the owner's own room: it must win
        # over whatever the theme assigned above, not merely fill a gap.
        colors[self.porch_config.owner_room] = self.porch_config.owner_accent
        return {
            "ok": True,
            "channels": entries,
            "signing": lease.status(self.root),
            "server_time": time.time(),
            "colors": colors,
            "rooms": sorted(rooms),
            "poll_interval_s": POLL_S,
            "channel_poll_interval_s": CHANNEL_POLL_S,
            "owner_room": self.porch_config.owner_room,
            "owner_label": self.porch_config.label,
            "owner_accent": self.porch_config.owner_accent,
            "fallback_palette": list(FALLBACK_PALETTE),
        }

    def _render(self, msgs: list[dict], *, device: str, channel: str,
                previous: dict | None = None, by_id: dict | None = None) -> list[dict]:
        by_id = index_by_id(self.messages(channel)) if by_id is None else by_id
        dr_index = render.dr_index_for(
            self._dr_records, channel, label=self.porch_config.label
        )
        # "Own" is the committed ledger OR live positive verification —
        # never the forgeable `from` field, never the persisted cache (§5).
        own = self.own_ids()
        own |= {m["id"] for m in msgs if self.verifier.is_verified(m["id"])}
        rooms = registered_rooms(self.porch_config)
        out = []
        for msg in msgs:
            out.append(
                render.message_json(
                    msg,
                    root=self.root,
                    device=device,
                    theme=self.theme,
                    rooms=rooms,
                    own_ids=own,
                    dr_index=dr_index,
                    by_id=by_id,
                    owner_room=self.porch_config.owner_room,
                    previous=previous,
                    spool_dir=self.spool_dir,
                    wire=self.porch_config.wire,
                    owner_accent=self.porch_config.owner_accent,
                )
            )
            previous = msg
        return out

    def messages_page(self, device: str, channel: str, after: str | None, limit: int | None) -> dict:
        channel = self.known_channel(channel)
        everything = self.messages(channel)
        msgs = [m for m in everything if m["id"] > after] if after else list(everything)
        limit = MESSAGE_PAGE_LIMIT if not limit else max(1, min(int(limit), MESSAGE_PAGE_LIMIT))
        page = msgs[-limit:] if len(msgs) > limit else msgs
        # The message before the page, so an incremental ?after= poll does not
        # claim a day separator on every batch's first message.
        previous = None
        if page:
            start = next((i for i, m in enumerate(everything) if m["id"] == page[0]["id"]), 0)
            previous = everything[start - 1] if start else None
        out = self._render(page, device=device, channel=channel, previous=previous,
                           by_id=index_by_id(everything))
        tip = page[-1]["id"] if page else (after or "")
        payload = {"ok": True, "messages": out, "tip": tip}
        if tip:
            payload["delivery_token"] = tokens.mint(
                self.root, "delivery", {"d": device, "c": channel, "t": tip},
                DELIVERY_TOKEN_TTL_S,
            )
        return payload

    def ack(self, device: str, channel: str, through_id: str, delivery_token: str) -> dict:
        channel = self.known_channel(channel)
        claims = tokens.verify(self.root, "delivery", delivery_token)
        if claims is None or claims.get("d") != device or claims.get("c") != channel:
            raise ApiError("delivery_token_invalid", "that delivery token is not valid here", 403)
        tip = str(claims.get("t") or "")
        if not isinstance(through_id, str) or not through_id:
            raise ApiError("bad_request", "through_id is required")
        if through_id > tip:
            raise ApiError(
                "ack_beyond_tip",
                "cannot move past what the server actually served",
                409,
            )
        if through_id not in {m["id"] for m in self.messages(channel)}:
            raise ApiError("ack_unknown_message", "no such message in this channel", 409)
        try:
            result = postcli.discard_through(
                channel, through_id, config=self.porch_config
            )
        except postcli.PostUnavailable as exc:
            raise ApiError("discard_through_unavailable", str(exc), 503) from exc
        return {"ok": True, **result}

    def seen(self, channel: str, message_id: str) -> dict:
        channel = self.known_channel(channel)
        if message_id not in {m["id"] for m in self.messages(channel)}:
            raise ApiError("no_such_message", "no such message in this channel", 404)
        try:
            who = postcli.seen_by(channel, message_id, config=self.porch_config)
        except postcli.PostUnavailable as exc:
            raise ApiError("seen_unavailable", str(exc), 503) from exc
        return {"ok": True, "seen_by": [sanitize_display(name) for name in who]}

    def transcript(self, channel: str) -> str:
        channel = self.known_channel(channel)
        return render.transcript_text(channel, self.messages(channel))

    def dr(self) -> dict:
        records = self.reload_dr()
        return {
            "ok": True,
            "records": [
                {
                    "dr": r["dr"],
                    "title": sanitize_display(r.get("title", "")),
                    "project": sanitize_display(r.get("project", "")),
                    "channel": sanitize_display(r.get("channel", "")),
                    "state": r.get("state", ""),
                    "badge": drstore.badge_for(
                        r.get("state", ""), label=self.porch_config.label
                    ),
                    "anchor_message_id": r.get("anchor_message_id", ""),
                    "created": r.get("created", ""),
                }
                for r in sorted(records.values(), key=lambda r: r["dr"])
            ],
            "signing": lease.status(self.root),
        }

    # ---- images ---------------------------------------------------------

    def upload_image(self, device: str, raw: bytes, content_type: str) -> dict:
        try:
            upload_id = imagesvc.store_upload(
                self.root, device=device, raw=raw, content_type=content_type,
                spool_dir=self.spool_dir,
            )
        except imagesvc.ImageError as exc:
            raise ApiError(exc.code, exc.message, 400) from exc
        return {"ok": True, "upload_id": upload_id}

    def reveal_image(self, device: str, message_id: str, index: int) -> dict:
        message = None
        with self._store_lock:
            for channel in self._channels or discover_channels(self.channels_root):
                for msg in self.messages(channel):
                    if msg["id"] == message_id:
                        message = msg
                        break
                if message is not None:
                    break
        if message is None:
            raise ApiError("no_such_message", "no such message", 404)
        try:
            grant = imagesvc.reveal(
                self.root,
                device=device,
                message=message,
                index=index,
                owner_room_dir=self.porch_config.owner_room_dir,
                mail_root=self.porch_config.mail_root,
                spool_dir=self.spool_dir,
                key_file=self.porch_config.key_file,
            )
        except imagesvc.ImageError as exc:
            raise ApiError(exc.code, exc.message, 400) from exc
        return {"ok": True, "grant": grant}

    def image_bytes(self, device: str, grant: str) -> bytes:
        try:
            path = imagesvc.redeem_grant(self.root, device=device, grant=grant)
            return imagesvc.thumbnail_png(path)
        except imagesvc.ImageError as exc:
            raise ApiError(exc.code, exc.message, 403) from exc
        except Exception as exc:
            raise ApiError("image_unavailable", "that image is no longer available", 404) from exc

    # ---- signing --------------------------------------------------------

    def signing(self) -> dict:
        return {"ok": True, **lease.status(self.root)}

    def signing_lock(self) -> dict:
        with self._send_lock, self._operation():
            ok, message = lease.lock(self.root)
        return {"ok": ok, "message": message, **lease.status(self.root)}

    # ---- sends ----------------------------------------------------------

    @contextmanager
    def _operation(self):
        """The send queue, held across process boundaries (§3).

        `porch-mobile arm`/`lock` run in another process and take the same
        flock, so a lease mutation typed at the Mac can no longer land
        between a send's arm-check and its ssh-keygen.
        """
        try:
            with operation_lock(self.root, timeout=OPERATION_TIMEOUT_S):
                yield
        except OperationBusy as exc:
            raise ApiError("operation_busy", str(exc), 503, clear_draft=False) from exc

    def _execute(self, channel: str, body: str, *, signed: bool, anyway: bool):
        if not signed:
            return (
                send_as_owner(
                    channel, body, config=self.porch_config, anyway=anyway
                ),
                None,
            )
        env = lease.agent_env(self.root)
        if env is None:
            # The service socket vanished between is_armed and here (agent
            # death is not lock-mediated). Refuse before a Signer exists:
            # env=None would let subprocess inherit porchd's ambient
            # SSH_AUTH_SOCK and sign through an unrelated agent (P1/P5).
            # No sidecars are created and _finish keeps the draft.
            return SendResult(
                ok=False,
                error_code="sign_failed",
                message="signing went dark mid-send — draft kept",
            ), None
        signer = Signer(self.porch_config)
        signer.env = env
        return signer.sign_and_send(channel, body, anyway=anyway), signer

    def _finish(self, attempt: ledger.Attempt, result, signer, *, wire_body: str,
                device: str, channel: str, upload_ids: list[str]) -> dict:
        if result.ok:
            message_id = None
            sent = (result.raw or {}).get("message") if result.raw else None
            if isinstance(sent, dict) and isinstance(sent.get("id"), str):
                message_id = sent["id"]
            ledger.commit(self.root, attempt, ledger.SENT, message_id=message_id)
            imagesvc.consume(self.root, upload_ids=upload_ids, message_id=message_id)
            # The server says whether it signed; the phone never asserts it.
            return {"ok": True, "state": "sent", "attempt_id": attempt.attempt_id,
                    "message_id": message_id, "clear_draft": True,
                    "signed": attempt.intent == "signed"}

        if result.committed:
            if signer is not None:
                signer.retain_attempt_sidecars()
            ledger.commit(self.root, attempt, ledger.COMMITTED_OUTPUT_FAILURE,
                          error=result.error_code, detail=result.message)
            # Committed is committed: the attachment went out with it.
            imagesvc.consume(self.root, upload_ids=upload_ids, message_id=None)
            return {
                "ok": False,
                "state": ledger.COMMITTED_OUTPUT_FAILURE,
                "attempt_id": attempt.attempt_id,
                "clear_draft": True,
                "error": {
                    "code": "committed_output_failure",
                    "message": f"OUTPUT FAILED (committed — do not retry): "
                               f"{result.message or result.error_code}",
                },
            }

        if signer is not None:
            signer.clean_attempt_sidecars()

        if result.crossed:
            ledger.commit(self.root, attempt, ledger.CROSSED, wire_body=wire_body,
                          error=result.error_code)
            # The draft survives a bounce, so its chips must too.
            imagesvc.hold_for_confirm(self.root, upload_ids=upload_ids,
                                      origin_attempt_id=attempt.attempt_id,
                                      ttl_s=BOUNCE_TOKEN_TTL_S)
            bounce = tokens.mint(
                self.root,
                "bounce",
                {
                    "d": device,
                    "c": channel,
                    "dh": attempt.draft_hash,
                    "wh": attempt.wire_hash,
                    "i": attempt.intent,
                    "o": attempt.attempt_id,
                },
                BOUNCE_TOKEN_TTL_S,
            )
            return {
                "ok": False,
                "state": ledger.CROSSED,
                "attempt_id": attempt.attempt_id,
                "clear_draft": False,
                "bounce_token": bounce,
                # Full message shape, like the TUI's banner: the missed
                # messages are the reason to reconsider, so they get the same
                # colors, badges and mention highlighting as the transcript.
                "missed": self._render(result.missed, device=device, channel=channel),
                "error": {"code": "crossed_send",
                          "message": "unseen messages land before yours"},
            }

        ledger.commit(self.root, attempt, ledger.REFUSED, error=result.error_code,
                      detail=result.message)
        # Uncommitted: the draft is retryable, so the chips go back on the shelf.
        imagesvc.release(self.root, upload_ids=upload_ids)
        return {
            "ok": False,
            "state": ledger.REFUSED,
            "attempt_id": attempt.attempt_id,
            "clear_draft": False,
            "error": {"code": result.error_code or "send_failed",
                      "message": result.message or "SEND FAILED"},
        }

    def _idempotent(self, outcome: ledger.Outcome, attempt: ledger.Attempt) -> dict | None:
        if outcome.kind == "proceed":
            return None
        prior = outcome.prior or {}
        if outcome.kind == "conflict":
            raise ApiError(
                "idempotency_conflict",
                "that attempt id was already used for a different request",
                409,
            )
        if outcome.kind == "unknown":
            # Whatever this attempt had reserved is ambiguous too: the send
            # may have landed with those images attached.
            imagesvc.mark_unknown(
                self.root,
                upload_ids=imagesvc.held_for(self.root, attempt.attempt_id,
                                             states=(imagesvc.RESERVED,)),
                attempt_id=attempt.attempt_id,
            )
            return {
                "ok": False,
                "state": ledger.UNKNOWN,
                "attempt_id": prior.get("attempt_id"),
                "clear_draft": False,
                "error": {
                    "code": "outcome_unknown",
                    "message": "outcome unknown — this may have landed. "
                               "Check the channel before retrying.",
                },
            }
        state = prior.get("state")
        replay = {
            "ok": state == ledger.SENT,
            "state": state,
            "attempt_id": prior.get("attempt_id"),
            "message_id": prior.get("message_id"),
            "clear_draft": state in (ledger.SENT, ledger.COMMITTED_OUTPUT_FAILURE),
            "replayed": True,
        }
        if state != ledger.SENT:
            replay["error"] = {"code": prior.get("error") or state,
                               "message": prior.get("detail") or state}
        return replay

    def send(self, device: str, channel: str, payload: dict) -> dict:
        channel = self.known_channel(channel)
        attempt_id = payload.get("attempt_id")
        draft_text = payload.get("draft_text")
        intent = payload.get("intent") or "unsigned"
        attachments = payload.get("attachments") or []
        if not isinstance(attempt_id, str) or not attempt_id:
            raise ApiError("bad_request", "attempt_id is required")
        if not isinstance(draft_text, str):
            raise ApiError("bad_request", "draft_text is required")
        if intent not in ("signed", "unsigned"):
            raise ApiError("bad_request", "intent must be 'signed' or 'unsigned'")
        if not isinstance(attachments, list) or not all(isinstance(a, str) for a in attachments):
            raise ApiError("bad_request", "attachments must be a list of upload ids")

        request_hash = ledger.request_hash(
            channel=channel, draft_text=draft_text, attachments=attachments, intent=intent
        )
        attempt = ledger.Attempt(
            attempt_id=attempt_id,
            device=device,
            channel=channel,
            draft_hash=policy.draft_hash(draft_text, attachments),
            wire_hash="",
            intent=intent,
            request_hash=request_hash,
            kind="send",
            extra={"draft_id": payload.get("draft_id")},
        )

        with self._send_lock, self._operation():
            replay = self._idempotent(ledger.begin(self.root, attempt), attempt)
            if replay is not None:
                return replay

            try:
                # Reserved, not consumed: the chips have to outlive a bounce.
                spool_paths = imagesvc.reserve(
                    self.root, device=device, upload_ids=attachments, attempt_id=attempt_id
                )
            except imagesvc.ImageError as exc:
                ledger.commit(self.root, attempt, ledger.REFUSED, error=exc.code,
                              detail=exc.message)
                raise ApiError(exc.code, exc.message, 400) from exc

            def _refuse(code: str, message: str, status: int) -> ApiError:
                ledger.commit(self.root, attempt, ledger.REFUSED, error=code, detail=message)
                imagesvc.release(self.root, upload_ids=attachments)
                return ApiError(code, message, status, clear_draft=False)

            armed = lease.is_armed(self.root)
            if intent == "signed" and not armed:
                # P1: never downgrade a signed intent. Draft preserved.
                raise _refuse(
                    "signing_unavailable",
                    "signing is dark — arm the lease at the Mac, or send unsigned",
                    409,
                )

            outcome = policy.dispatch(
                draft_text,
                channel=channel,
                attachments=attachments,
                spool_paths=spool_paths,
                intent=intent,
                armed=armed,
                messages=self.messages(channel),
                dr_records=self._dr_records,
                dr_log_path=self.porch_config.dr_log_path,
            )
            if isinstance(outcome, policy.Refusal):
                raise _refuse(outcome.code, outcome.message, 400)

            attempt.wire_hash = outcome.wire_hash
            result, signer = self._execute(channel, outcome.body, signed=(intent == "signed"),
                                           anyway=False)
            response = self._finish(attempt, result, signer, wire_body=outcome.body,
                                    device=device, channel=channel, upload_ids=attachments)
            if outcome.dr_event is not None:
                response["dr_event"] = outcome.dr_event["dr"]
                self.reload_dr()
            return response

    def confirm(self, device: str, channel: str, payload: dict) -> dict:
        channel = self.known_channel(channel)
        attempt_id = payload.get("confirm_attempt_id") or payload.get("attempt_id")
        bounce_token = payload.get("bounce_token")
        if not isinstance(attempt_id, str) or not attempt_id:
            raise ApiError("bad_request", "confirm_attempt_id is required")
        if not isinstance(bounce_token, str) or not bounce_token:
            raise ApiError("bad_request", "bounce_token is required")
        claims = tokens.verify(self.root, "bounce", bounce_token)
        if claims is None or claims.get("d") != device or claims.get("c") != channel:
            raise ApiError("bounce_token_invalid", "that confirmation expired — send again", 403)

        origin_id = str(claims.get("o") or "")
        intent = str(claims.get("i") or "unsigned")
        request_hash = ledger.request_hash(
            channel=channel,
            draft_text=f"confirm:{origin_id}:{claims.get('wh')}",
            attachments=[],
            intent=intent,
        )
        attempt = ledger.Attempt(
            attempt_id=attempt_id,
            device=device,
            channel=channel,
            draft_hash=str(claims.get("dh") or ""),
            wire_hash=str(claims.get("wh") or ""),
            intent=intent,
            request_hash=request_hash,
            kind="confirm",
            extra={"origin_attempt_id": origin_id},
        )

        with self._send_lock, self._operation():
            spender = ledger.bounce_consumed_by(self.root, origin_id)
            if spender is not None and spender != attempt_id:
                raise ApiError(
                    "bounce_token_consumed",
                    "that crossed send was already confirmed",
                    409,
                )
            replay = self._idempotent(ledger.begin(self.root, attempt), attempt)
            if replay is not None:
                return replay

            # The confirm inherits the crossed attempt's held chips.
            upload_ids = imagesvc.held_for(
                self.root, origin_id, states=(imagesvc.RESERVED_FOR_CONFIRM,)
            )
            imagesvc.transfer(self.root, upload_ids=upload_ids, attempt_id=attempt_id)

            def _refuse(code: str, message: str) -> ApiError:
                ledger.commit(self.root, attempt, ledger.REFUSED, error=code, detail=message)
                imagesvc.release(self.root, upload_ids=upload_ids)
                return ApiError(code, message, 409, clear_draft=False)

            origin = ledger.latest(self.root, origin_id)
            if not origin or origin.get("state") != ledger.CROSSED:
                raise _refuse("bounce_origin_missing",
                              "the original attempt is no longer crossed")
            wire_body = origin.get("wire_body")
            if not isinstance(wire_body, str) or policy.wire_hash(wire_body) != attempt.wire_hash:
                raise _refuse("wire_mismatch", "the stored wire body no longer matches")

            # P1: a lease that expired while the owner read the banner fails closed.
            if intent == "signed" and not lease.is_armed(self.root):
                raise _refuse("signing_unavailable",
                              "signing went dark before you confirmed — draft kept")

            result, signer = self._execute(channel, wire_body, signed=(intent == "signed"),
                                           anyway=True)
            if result.crossed:
                # --anyway must not cross; treat as an ordinary refusal so the
                # state graph stays pending → one terminal state.
                if signer is not None:
                    signer.clean_attempt_sidecars()
                raise _refuse("crossed_after_anyway",
                              "post still refused the send — draft kept")
            return self._finish(attempt, result, signer, wire_body=wire_body,
                                device=device, channel=channel, upload_ids=upload_ids)

    def dismiss(self, device: str, channel: str, payload: dict) -> dict:
        """"Keep editing" — the explicit release of a bounce's held chips (§5).

        The crossed attempt keeps its terminal state; only the attachment
        reservations come back, so the edited draft can go out fresh.
        """
        channel = self.known_channel(channel)
        bounce_token = payload.get("bounce_token")
        if not isinstance(bounce_token, str) or not bounce_token:
            raise ApiError("bad_request", "bounce_token is required")
        claims = tokens.verify(self.root, "bounce", bounce_token)
        if claims is None or claims.get("d") != device or claims.get("c") != channel:
            raise ApiError("bounce_token_invalid", "that confirmation expired", 403)
        origin_id = str(claims.get("o") or "")
        with self._send_lock, self._operation():
            if ledger.bounce_consumed_by(self.root, origin_id) is not None:
                raise ApiError("bounce_token_consumed",
                               "that crossed send was already confirmed", 409)
            upload_ids = imagesvc.held_for(
                self.root, origin_id, states=(imagesvc.RESERVED_FOR_CONFIRM,)
            )
            imagesvc.release(self.root, upload_ids=upload_ids)
        return {"ok": True, "released": len(upload_ids)}
