"""porch3 Textual application."""

from __future__ import annotations

import sys
from pathlib import Path

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.css.query import NoMatches
from textual.widgets import Footer, Static

from porch3 import drstore
from porch3.commands import copy_out, img_body, save_transcript, seen_by, vote_text
from porch3.config import ConfigError, PorchConfig, load_config
from porch3.constants import (
    CHANNEL_POLL_S,
    POLL_S,
    PRESENCE_POLL_S,
)
from porch3.platform import require_macos
from porch3.presence import fetch_presence
from porch3.sanitize import sanitize_display
from porch3.send import catch_up_as_owner, send_as_owner
from porch3.signer import Signer, resolve_service_lease
from porch3.store import (
    channel_description,
    channel_store,
    load_all,
    load_new,
    sync_channels,
)
from porch3.theme import SenderTheme
from porch3 import verify as verify_mod
from porch3.verify import enqueue_verifications, load_verify_cache
from porch3.widgets import BounceBanner, ChannelBrowser, Composer, MessageList


class PorchApp(App):
    """Groupchat face — Textual port of porch."""

    TITLE = "porch3"
    CSS = """
    Screen {
        layout: vertical;
    }
    #status-bar {
        height: 1;
        background: $accent;
        color: $text;
        padding: 0 1;
    }
    #chat-pane, #browser-pane {
        height: 1fr;
    }
    #browser-pane {
        display: none;
    }
    .-browsing #chat-pane {
        display: none;
    }
    .-browsing #browser-pane {
        display: block;
    }
    #composer-wrap {
        height: auto;
        max-height: 10;
    }
    """

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit", show=True),
        Binding("escape", "escape", "Back/Dismiss", show=False),
        Binding("right", "open_channel", "Open", show=False),
        Binding("up", "browser_up", "Up", show=False),
        Binding("down", "browser_down", "Down", show=False),
        Binding("pageup", "page_up", "Page Up", show=False, priority=True),
        Binding("pagedown", "page_down", "Page Down", show=False, priority=True),
        # ctrl+r with priority: reachable while the composer has focus, and a
        # chord can't collide with ordinary typing the way bare "r" does.
        Binding("ctrl+r", "reveal_images", "Reveal images", show=False, priority=True),
        # ctrl+v: paste a clipboard IMAGE (screenshot, copied picture) as an
        # attachment. Falls back to the TextArea's internal text paste when
        # the clipboard has no image. Cmd+V (terminal paste) is untouched.
        Binding("ctrl+v", "paste_image", "Paste image", show=False, priority=True),
    ]

    def __init__(
        self,
        *,
        porch_config: PorchConfig,
        channel: str | None = None,
        signer: Signer | None = None,
        channels_root: Path | None = None,
        skip_join: bool = False,
    ) -> None:
        super().__init__()
        self.porch_config = porch_config
        self.initial_channel = channel or porch_config.initial_channel
        self.signer = signer or Signer(porch_config)
        self.channels_root = channels_root or porch_config.channels_dir
        self.skip_join = skip_join
        self.theme_colors = SenderTheme()
        self.known_channels: set[str] = set()
        self.channels: list[str] = []
        self.current = channel
        self.mode = "chat"  # chat | channels
        self.msgs: list[dict] = []
        self.seen: set[str] = set()  # filename stems (== envelope ids)
        self.drafts: dict[str, str] = {}
        self.status = "connecting"
        self.dr_records: dict[str, dict] = {}
        self._pending_anyway = False
        self._pending_text: str | None = None
        # What the composer showed when the bounce fired (e.g. the /vote
        # command), distinct from the expanded wire text in _pending_text.
        # Set in the crossed branch; cleared wherever _pending_text is.
        self._pending_display: str | None = None

    def compose(self) -> ComposeResult:
        from porch3.mentions import registered_rooms

        rooms = registered_rooms(self.porch_config)
        yield Static("", id="status-bar")
        with Vertical(id="chat-pane"):
            yield MessageList(
                self.theme_colors,
                owner_room=self.porch_config.owner_room,
                owner_accent=self.porch_config.owner_accent,
                wire=self.porch_config.wire,
                rooms=rooms,
                id="messages",
            )
            yield BounceBanner(
                self.theme_colors,
                owner_room=self.porch_config.owner_room,
                owner_accent=self.porch_config.owner_accent,
                wire=self.porch_config.wire,
                rooms=rooms,
                id="bounce",
            )
            with Vertical(id="composer-wrap"):
                yield Composer(id="composer")
        with Vertical(id="browser-pane"):
            yield ChannelBrowser(id="browser")
        yield Footer()

    def on_mount(self) -> None:
        from porch3.images import prune_spool

        self.run_worker(
            lambda: prune_spool(), thread=True, group="spool-prune"
        )
        verify_mod.set_verify_done_callback(self._verify_done_from_worker)
        if self.skip_join:
            from porch3.store import discover_channels

            self.channels = discover_channels(self.channels_root)
            self.known_channels = set(self.channels)
        else:
            self.channels, failures = sync_channels(
                self.known_channels, self.channels_root,
                config=self.porch_config,
            )
            if failures:
                self.status = "JOIN FAILED: " + ", ".join(failures)
            else:
                self.status = "connected"
        if not self.channels:
            self.status = "no channels"
            self._refresh_status()
            return
        if self.current not in self.channels:
            self.current = self.channels[0]
        for ch in self.channels:
            self.drafts.setdefault(ch, "")
        self._open_channel(self.current, first=True)
        # Projection may verify ratification messages via subprocess — never
        # on the UI thread.
        self.run_worker(
            self._reload_dr_records, thread=True, exclusive=True, group="dr"
        )
        self.set_interval(POLL_S, self._poll_messages)
        self.set_interval(CHANNEL_POLL_S, self._poll_channels)
        self.set_interval(PRESENCE_POLL_S, self._poll_presence)
        self.query_one("#composer", Composer).focus()
        self._refresh_status()

    def on_unmount(self) -> None:
        verify_mod.set_verify_done_callback(None)

    # ── channel / message loading ─────────────────────────────────────

    def _open_channel(self, channel: str, *, first: bool = False) -> None:
        self.current = channel
        self.msgs = load_all(channel, self.channels_root)
        # Key seen on filename stem (parse_msg requires id == stem)
        self.seen = {m.get("stem", m["id"]) for m in self.msgs}
        enqueue_verifications(self.msgs, wire=self.porch_config.wire)
        messages = self.query_one("#messages", MessageList)
        messages.set_channel_header(
            channel, channel_description(channel, self.channels_root)
        )
        messages.set_messages(self.msgs)
        composer = self.query_one("#composer", Composer)
        composer.set_draft(self.drafts.get(channel, ""))
        self.mode = "chat"
        self.remove_class("-browsing")
        self.query_one("#bounce", BounceBanner).hide()
        self._pending_anyway = False
        self._pending_text = None
        self._pending_display = None
        if not first:
            self.status = "connected"
        composer.focus()
        self._refresh_status()
        # Badge index is per-channel; rebuild it for the channel we just
        # opened (records themselves are already loaded).
        self._refresh_dr_index()
        self._catch_up()

    def _catch_up(self) -> None:
        """Rendered == read: move the owner's cursor to tip.

        Porch shows every message on screen, so post's unread state is
        honestly stale — discarding it keeps sends from bouncing on backlog
        the owner has literally seen. A message landing mid-compose (after the
        last poll) still triggers post's crossed_send guard, as it should.
        """
        if not self.skip_join and self.current:
            catch_up_as_owner(self.current, config=self.porch_config)

    def _poll_messages(self) -> None:
        if self.mode != "chat" or not self.current:
            return
        fresh = load_new(self.current, self.seen, self.channels_root)
        if not fresh:
            return
        for m in fresh:
            self.seen.add(m.get("stem", m["id"]))
            self.msgs.append(m)
        enqueue_verifications(fresh, wire=self.porch_config.wire)
        self.query_one("#messages", MessageList).append_messages(fresh)
        self._observe_dr_actions(fresh)
        self._catch_up()

    def _poll_channels(self) -> None:
        if self.skip_join:
            from porch3.store import discover_channels

            self.channels = discover_channels(self.channels_root)
        else:
            self.channels, failures = sync_channels(
                self.known_channels, self.channels_root,
                config=self.porch_config,
            )
            if failures:
                self.status = "JOIN FAILED: " + ", ".join(failures)
        for ch in self.channels:
            self.drafts.setdefault(ch, "")
        if self.mode == "channels":
            self._refresh_browser()
        self._refresh_status()

    def _poll_presence(self) -> None:
        presence = fetch_presence(config=self.porch_config)
        if self.mode == "channels":
            browser = self.query_one("#browser", ChannelBrowser)
            browser.set_presence(presence)
        self._presence = presence

    def _refresh_browser(self) -> None:
        browser = self.query_one("#browser", ChannelBrowser)
        browser.set_channels(
            self.channels,
            selected=self.current,
            presence=getattr(self, "_presence", {}),
            root=self.channels_root,
        )

    def _refresh_status(self) -> None:
        signing = "🔏 signing ON" if self.signer.env else "unsigned chat"
        if self.channels and self.current in self.channels:
            pos = f"{self.channels.index(self.current) + 1}/{len(self.channels)}"
        else:
            pos = "—"
        bar = Text(
            sanitize_display(
                f" #{self.current} [{pos}] · {signing} · "
                f"← channels · {self.status} "
            )
        )
        self.query_one("#status-bar", Static).update(bar)

    # ── verify badge live updates ─────────────────────────────────────

    def _verify_done_from_worker(self, mid: str, badge: str) -> None:
        """Worker-thread callback → hop onto the Textual thread."""
        try:
            self.call_from_thread(self._on_verify_done, mid, badge)
        except Exception:
            # App may be shutting down
            pass

    def _on_verify_done(self, mid: str, _badge: str) -> None:
        try:
            messages = self.query_one("#messages", MessageList)
        except Exception:
            return
        messages.update_verify_badge(mid)

    # ── actions / bindings ────────────────────────────────────────────

    def action_quit(self) -> None:
        self.exit()

    def action_reveal_images(self) -> None:
        if self.mode != "chat":
            return
        n = self.query_one("#messages", MessageList).reveal_images_for()
        if n:
            self.status = f"rendered {n} image(s)"
            self._refresh_status()

    def action_paste_image(self) -> None:
        if self.mode != "chat":
            return
        self.status = "checking clipboard…"
        self._refresh_status()
        # Own group: exclusive=True in the default group would cancel the
        # image-thumbnail workers MessageBlock runs (same default group).
        self.run_worker(
            self._paste_image_worker, thread=True, exclusive=True, group="paste-image"
        )

    def _paste_image_worker(self) -> None:
        """Thread worker: osascript/sips clipboard grab stays off the UI thread."""
        from porch3.images import clipboard_image_to_spool

        try:
            spooled, reason = clipboard_image_to_spool()
        except Exception:
            spooled, reason = None, "clipboard image failed to import"
        self.call_from_thread(self._paste_image_done, spooled, reason)

    def _paste_image_done(
        self, spooled: Path | None, reason: str | None = None
    ) -> None:
        # The worker can take seconds — the user may have left chat mode or
        # be quitting; never re-enter stale UI state.
        if self.mode != "chat":
            return
        try:
            composer = self.query_one("#composer", Composer)
        except NoMatches:
            return
        if spooled is None:
            if reason is None:
                # No image on the clipboard — behave like the TextArea's own
                # ctrl+v (internal text paste) that our priority binding
                # shadowed. A rejected image (reason set) must NOT splice
                # text over the selection.
                composer.action_paste()
                self.status = "no image on clipboard"
            else:
                self.status = reason
        else:
            before = composer.text
            sep = "" if (not before or before.endswith((" ", "\n"))) else " "
            # Append at the end: the separator is decided from the end of the
            # draft, and a mid-draft cursor splicing a path into a word helps
            # nobody.
            composer.move_cursor(composer.document.end)
            composer.insert(f"{sep}{spooled} ")
            self.status = "image attached — Enter to send"
        self._refresh_status()
        composer.focus()

    def action_escape(self) -> None:
        bounce = self.query_one("#bounce", BounceBanner)
        if bounce.active:
            bounce.hide()
            self._pending_anyway = False
            self._pending_text = None
            self._pending_display = None
            self.status = "editing (bounce dismissed)"
            self._refresh_status()
            self.query_one("#composer", Composer).focus()
            return
        if self.mode == "channels":
            self.mode = "chat"
            self.remove_class("-browsing")
            self.query_one("#composer", Composer).focus()

    def on_composer_channels_requested(
        self, _event: Composer.ChannelsRequested
    ) -> None:
        self.action_channels()

    def action_channels(self) -> None:
        if self.mode == "channels":
            return
        composer = self.query_one("#composer", Composer)
        # Only when composer is empty (v2 invariant)
        if composer.text.strip():
            return
        self.drafts[self.current] = composer.text
        self.mode = "channels"
        self.add_class("-browsing")
        self._poll_presence()
        self._refresh_browser()

    def action_open_channel(self) -> None:
        if self.mode != "channels":
            return
        self.query_one("#browser", ChannelBrowser).open_selected()

    def action_browser_up(self) -> None:
        if self.mode == "channels":
            self.query_one("#browser", ChannelBrowser).move(-1)

    def action_browser_down(self) -> None:
        if self.mode == "channels":
            self.query_one("#browser", ChannelBrowser).move(1)

    def action_page_up(self) -> None:
        if self.mode == "chat":
            messages = self.query_one("#messages", MessageList)
            # scroll_page_down/up defer their real scroll via
            # scroll_to(immediate=False), which re-releases the anchor AFTER
            # this action returns — a no-op scroll at the bottom would strand
            # bottom-follow forever. Scroll immediately (the same path
            # Textual's own pointer-scroll uses) so the release happens once,
            # synchronously, then re-arm the anchor via _check_anchor (which
            # only re-arms when the viewport is genuinely at the end).
            messages._scroll_to(
                y=messages.scroll_y - messages.scrollable_content_region.height,
                animate=False,
            )
            messages._check_anchor()

    def action_page_down(self) -> None:
        if self.mode == "chat":
            messages = self.query_one("#messages", MessageList)
            messages._scroll_to(
                y=messages.scroll_y + messages.scrollable_content_region.height,
                animate=False,
            )
            messages._check_anchor()

    def on_channel_browser_open_requested(
        self, event: ChannelBrowser.OpenRequested
    ) -> None:
        self._open_channel(event.channel)

    # ── composer submit ───────────────────────────────────────────────

    def on_composer_submitted(self, event: Composer.Submitted) -> None:
        bounce = self.query_one("#bounce", BounceBanner)
        composer = self.query_one("#composer", Composer)
        current_raw = composer.text
        current = current_raw.strip()

        if bounce.active:
            # Compare against what the composer DISPLAYED at bounce time, not
            # the expanded wire text — an unchanged /vote or /img must resend
            # its wire body with --anyway, never the raw slash command.
            pending_display = self._pending_display or ""
            wire = self._pending_text
            bounce.hide()
            if current_raw == pending_display and wire:
                self._do_send(wire, anyway=True)
                return
            # Edited while the banner was up — dismiss and run the normal
            # submit path (slash commands re-expand, drafts re-tracked).
            self._pending_anyway = False
            self._pending_text = None
            self._pending_display = None
            if not current:
                return
            self._submit_text(event.text)
            return

        self._submit_text(event.text)

    # ── Decision Records (docs/decision-records.md) ──────────────────

    def _reload_dr_records(self) -> None:
        """Thread worker: replay + project (may run porch-verify).

        Stamped with a sequence number: exclusive=True cannot interrupt a
        running thread, so a slow older projection could land after a newer
        one and revert dr_records to a stale view (review major).
        """
        self._dr_seq = getattr(self, "_dr_seq", 0) + 1
        seq = self._dr_seq
        pc = self.porch_config
        records = drstore.project(
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
        self.call_from_thread(self._dr_records_loaded, records, seq)

    def _dr_records_loaded(self, records: dict[str, dict], seq: int = 0) -> None:
        if seq < getattr(self, "_dr_applied_seq", 0):
            return
        self._dr_applied_seq = seq
        self.dr_records = records
        self._refresh_dr_index()

    def _refresh_dr_index(self) -> None:
        """Badge index for the CURRENT channel only — message ids are
        per-channel timestamp stems, so a cross-channel index lets a
        colliding or deliberately-named .msg wear another record's badge
        (review major)."""
        try:
            messages = self.query_one("#messages", MessageList)
        except NoMatches:
            return
        index = {
            r["anchor_message_id"]: (r["dr"], r["state"])
            for r in self.dr_records.values()
            if r.get("anchor_message_id") and r.get("channel") == self.current
        }
        messages.set_dr_index(index)

    def _observe_dr_actions(self, fresh: list[dict]) -> None:
        """The owner's signed action message IS the authority instrument.

        parse_action_body is a full-body anchored match on the signed wire
        format — an action phrase embedded inside any longer message (e.g.
        quoted in prose, or injected into an offer title) never parses
        (review blocker: `search` here let untrusted text reach an
        owner-signed body and ratify an arbitrary record). Appends are
        deduped per actor message id; projection re-verifies the signature,
        so a spoofed `from: <owner_room>` sender changes nothing durable.
        """
        appended = False
        events = None
        for m in fresh:
            if m.get("from") != self.porch_config.owner_room:
                continue
            parsed = drstore.parse_observed_action(
                m,
                owner_room=self.porch_config.owner_room,
                wire=self.porch_config.wire,
            )
            if parsed is None:
                continue
            dr, verb, new_dr = parsed
            record = self.dr_records.get(dr)
            if record is None:
                continue
            if verb != "superseded" and record["state"] != "needs_operator_decision":
                continue
            if events is None:
                events = drstore.replay(self.porch_config.dr_log_path)
            if drstore.has_actor_event(events, m["id"]):
                continue
            try:
                if verb == "superseded":
                    if new_dr in self.dr_records:
                        # The message reads "DR <old> superseded by <new>";
                        # dr is the old record, new_dr the replacement.
                        drstore.supersede(
                            dr, new_dr, m["id"], self.porch_config.dr_log_path
                        )
                else:
                    verdict = "ratified" if verb == "accepted" else "rejected"
                    drstore.decide(
                        dr, verdict, m["id"], self.porch_config.dr_log_path
                    )
                appended = True
            except (OSError, ValueError):
                self.status = f"DR: failed to record action for {dr}"
                self._refresh_status()
        if appended:
            self.run_worker(
                self._reload_dr_records, thread=True, exclusive=True, group="dr"
            )

    def _dr_command(self, text: str) -> None:
        """Failed guards preserve the draft (like /vote); only successful
        actions clear it. drstore errors surface as status, never crash the
        event handler."""
        parts = text.split()
        cmd = parts[0]
        ok = False
        try:
            if cmd == "/dr":
                pending = [
                    r["dr"]
                    for r in self.dr_records.values()
                    if r["state"] == "needs_operator_decision"
                ]
                self.status = (
                    f"DR: {len(self.dr_records)} records, "
                    f"needs {self.porch_config.label}: {', '.join(sorted(pending)) or 'none'}"
                )
                ok = True
            elif cmd == "/decision":
                if len(parts) < 3:
                    self.status = "usage: /decision <msg-prefix> <project> [title]"
                else:
                    prefix, project = parts[1], parts[2]
                    matches = [
                        m for m in self.msgs if m["id"].startswith(prefix)
                    ]
                    if len(matches) == 0:
                        self.status = f"DR: no message here matching {prefix}"
                    elif len(matches) > 1:
                        # Silently anchoring the first of an ambiguous prefix
                        # bound the record to the wrong message (review MED).
                        self.status = (
                            f"DR: {len(matches)} messages match '{prefix}' — "
                            "use a longer prefix"
                        )
                    else:
                        anchor = matches[0]
                        title = " ".join(parts[3:]) or (
                            (anchor.get("body") or "")[:60].strip()
                            or anchor["id"]
                        )
                        # Display hygiene; authority never derives from
                        # titles (full-body action parse), but a derived
                        # title must not smuggle newlines or action glyphs
                        # into an owner-signed offer.
                        title = " ".join(title.replace("⚖", " ").split())
                        ev = drstore.propose(
                            title=title,
                            project=project,
                            channel=self.current,
                            anchor_message_id=anchor["id"],
                            path=self.porch_config.dr_log_path,
                        )
                        self._do_send(
                            drstore.offer_line(
                                {
                                    "dr": ev["dr"],
                                    "title": title,
                                    "project": project,
                                },
                                label=self.porch_config.label,
                            )
                        )
                        self.run_worker(
                            self._reload_dr_records,
                            thread=True,
                            exclusive=True,
                            group="dr",
                        )
                        return  # _do_send owns status + draft
            elif cmd in ("/accept", "/reject"):
                if len(parts) != 2:
                    self.status = f"usage: {cmd} <dr-id>"
                else:
                    dr = parts[1]
                    record = self.dr_records.get(dr)
                    if record is None:
                        self.status = f"DR: no such record {dr}"
                    elif record["state"] != "needs_operator_decision":
                        self.status = f"DR: {dr} is already {record['state']}"
                    else:
                        verb = "accepted" if cmd == "/accept" else "rejected"
                        self.drafts[self.current] = text
                        # The signed send is the instrument; observation of
                        # the exact action body appends the event.
                        self._do_send(f"⚖️ DR {dr} {verb}")
                        return
            elif cmd == "/supersede":
                if len(parts) != 3:
                    self.status = "usage: /supersede <old-dr> <new-dr>"
                else:
                    old, new = parts[1], parts[2]
                    old_rec = self.dr_records.get(old)
                    new_rec = self.dr_records.get(new)
                    # Mirror the projection rule so the owner never signs a
                    # supersede that projection will silently ignore: old !=
                    # new, both currently ratified.
                    if old_rec is None or new_rec is None:
                        self.status = "DR: both records must exist"
                    elif old == new:
                        self.status = "DR: a record cannot supersede itself"
                    elif old_rec["state"] != "ratified":
                        self.status = f"DR: {old} must be ratified to supersede (is {old_rec['state']})"
                    elif new_rec["state"] != "ratified":
                        self.status = f"DR: {new} must be ratified to replace (is {new_rec['state']})"
                    else:
                        self.drafts[self.current] = text
                        self._do_send(f"⚖️ DR {old} superseded by {new}")
                        return
        except (OSError, ValueError) as exc:
            self.status = f"DR error: {exc}"
        if ok:
            composer = self.query_one("#composer", Composer)
            composer.clear_draft()
            self.drafts[self.current] = ""
        self._refresh_status()

    def _submit_text(self, raw: str) -> None:
        composer = self.query_one("#composer", Composer)
        text = raw.strip()
        if not text:
            return

        # Dispatch EVERY slash command by exact first-token equality. A
        # `startswith` prefix check let `/votex choice` reach the /vote path
        # and broadcast `🗳️ x: choice` as the owner (review MAJOR); the same held
        # for /copy*, /img*, /seen*. First token decides; anything unknown
        # that begins with "/" is refused with the draft kept.
        first = text.split()[0]
        arg = text[len(first):].strip()

        if first in ("/quit", "/q"):
            self.exit()
            return
        if first == "/copy":
            self.status = copy_out(self.msgs, arg)
            composer.clear_draft()
            self.drafts[self.current] = ""
            self._refresh_status()
            return
        if first == "/save":
            self.status = save_transcript(self.current, self.msgs)
            composer.clear_draft()
            self.drafts[self.current] = ""
            self._refresh_status()
            return
        if first == "/vote":
            ballot, err = vote_text(arg)
            if err:
                self.status = err
                self._refresh_status()
                return
            # Keep draft until send succeeds (crossed/generic must be retryable)
            self.drafts[self.current] = raw
            self._do_send(ballot)  # type: ignore[arg-type]
            return
        if first == "/img":
            body, err = img_body(arg)
            if err:
                self.status = err
                self._refresh_status()
                return
            self.drafts[self.current] = raw
            self._do_send(body)  # type: ignore[arg-type]
            return
        if first == "/seen":
            self.status = seen_by(
                self.current, self.msgs, arg, config=self.porch_config
            )
            composer.clear_draft()
            self.drafts[self.current] = ""
            self._refresh_status()
            return
        if first in ("/dr", "/decision", "/accept", "/reject", "/supersede"):
            self._dr_command(text)
            return
        if first.startswith("/"):
            # Unknown/mistyped slash command must never broadcast as the owner.
            self.status = f"unknown command {first} (draft kept)"
            self._refresh_status()
            return

        # Keep draft until send succeeds (bounce must preserve it)
        self.drafts[self.current] = raw
        self._do_send(raw)

    def _do_send(self, text: str, *, anyway: bool = False) -> None:
        composer = self.query_one("#composer", Composer)
        if self.signer.env is not None:
            result = self.signer.sign_and_send(
                self.current, text, anyway=anyway
            )
        else:
            # Local import so tests can patch porch3.send.send_as_owner.
            from porch3.send import send_as_owner as _send

            result = _send(
                self.current, text, config=self.porch_config, anyway=anyway
            )

        if result.ok:
            composer.clear_draft()
            self.drafts[self.current] = ""
            self._pending_anyway = False
            self._pending_text = None
            self._pending_display = None
            self.status = "signed+sent" if self.signer.env else "sent"
            self._refresh_status()
            # Record the id we just emitted: spool-render privileges key on
            # this unspoofable set, never the forgeable `from` field (cs-c0d).
            sent = (result.raw or {}).get("message") if result.raw else None
            if isinstance(sent, dict) and isinstance(sent.get("id"), str):
                self.query_one("#messages", MessageList).mark_own(sent["id"])
            # Immediate poll so our own message appears
            self._poll_messages()
            # Sending always snaps to the bottom (re-arms bottom-follow even
            # if a scroll-up had released the anchor) — your own message must
            # be on screen after you send it.
            self.query_one("#messages", MessageList).anchor()
            return

        if result.committed:
            # delivered_output_failure etc. — side-effect already landed.
            # Clear draft so Enter-again cannot double-send; keep sidecars.
            composer.clear_draft()
            self.drafts[self.current] = ""
            self._pending_anyway = False
            self._pending_text = None
            self._pending_display = None
            if self.signer.env is not None:
                self.signer.retain_attempt_sidecars()
            self.status = (
                f"OUTPUT FAILED (committed — do not retry): "
                f"{result.message or result.error_code}"
            )
            self._refresh_status()
            return

        if result.crossed:
            # Uncommitted — clean orphan signed attempt sidecars
            if self.signer.env is not None:
                self.signer.clean_attempt_sidecars()
            # Keep draft intact; show missed; wait for Enter/Esc
            self._pending_anyway = True
            self._pending_text = text
            # Display text as the composer shows it (e.g. the /vote command),
            # captured before any mutation — the bounce branch compares
            # against this, never against the expanded wire text.
            self._pending_display = self.drafts.get(self.current) or text
            # Ensure composer still has the draft
            if not composer.text.strip():
                composer.set_draft(self.drafts.get(self.current) or text)
            bounce = self.query_one("#bounce", BounceBanner)
            bounce.show_missed(result.missed)
            self.status = "crossed_send — Enter=anyway Esc=edit"
            self._refresh_status()
            return

        # Generic uncommitted failure — preserve retryable draft, clean sidecars
        if self.signer.env is not None:
            self.signer.clean_attempt_sidecars()
        if not composer.text.strip():
            composer.set_draft(self.drafts.get(self.current) or text)
        self.status = result.message or "SEND FAILED"
        self._refresh_status()


def main(argv: list[str] | None = None) -> None:
    require_macos()
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("-h", "--help"):
        print(
            "usage: porch [channel]\n"
            "       porch init [--from-legacy]\n\n"
            "Textual groupchat TUI for post channels.\n"
            "Default channel comes from config (usually commons)."
        )
        return
    if argv and argv[0] == "init":
        from porch3 import initcli

        raise SystemExit(initcli.main(argv[1:]))
    try:
        config = load_config()
    except ConfigError as exc:
        if "missing config" in str(exc):
            print(
                f"{exc}\n"
                "First run: `porch init` (or `porch init --from-legacy`).",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc
        print(f"config error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    from porch3.roomcheck import (
        RoomInvariantError,
        apply_owner_crosscheck,
        assert_acting_room,
    )

    try:
        assert_acting_room(config)
        config = apply_owner_crosscheck(config)
    except RoomInvariantError as exc:
        print(f"room invariant: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    if config.signing_disabled:
        print(
            f"note: signing+verification disabled — "
            f"{config.signing_disabled_reason}",
            file=sys.stderr,
        )
    from porch3.verify import set_trust_context

    set_trust_context(config)
    channel = argv[0] if argv else config.initial_channel
    store = channel_store(channel, config.channels_dir)
    if not store.is_dir():
        sys.exit(
            f"no channel store at {store} — "
            f"is '{channel}' a real channel?"
        )
    if not config.signing_disabled:
        load_verify_cache()
    signer = Signer(config)
    lease = resolve_service_lease() if sys.stdin.isatty() else None
    if lease is not None:
        ans = input(
            f"mobile lease is ARMED until {lease.deadline_display} — "
            "use it for this session? [Y/n] "
        ).strip().lower()
        if ans in ("", "y", "yes"):
            signer.use_service_lease(lease)
    if (
        signer.env is None
        and config.key_file.exists()
        and not config.signing_disabled
        and sys.stdin.isatty()
    ):
        ans = input(
            "Enable signed sends for this session? [y/N] "
        ).strip().lower()
        if ans == "y" and not signer.start():
            print("signing setup failed — continuing unsigned")
    app = PorchApp(porch_config=config, channel=channel, signer=signer)
    try:
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        signer.stop()


if __name__ == "__main__":
    main()
