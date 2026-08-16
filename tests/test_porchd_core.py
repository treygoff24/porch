"""porchd policy, ledger, tokens, and rendering — the parts with no socket."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from conftest import make_id, make_porch_config

from porch3 import signer as signer_mod
from porch3.send import SendResult
from porch3.signature_v2 import MAX_SIGNED_BODY_BYTES
from porchd import imagesvc, lease, ledger, policy, tokens
from porchd import service as service_mod
from porchd.service import ApiError

# ---------------------------------------------------------------- dispatch


def _dispatch(text, **kw):
    params = dict(
        channel="commons",
        attachments=[],
        spool_paths=[],
        intent="unsigned",
        armed=False,
        messages=[],
        dr_records={},
    )
    params.update(kw)
    return policy.dispatch(text, **params)


def test_plain_text_is_its_own_wire():
    draft = " \tfirst\r\n\rsecond\n\u2028👩‍🚀🦊🔏 [signed:BAIT]\t\n"
    wire = _dispatch(draft)
    assert isinstance(wire, policy.Wire)
    assert wire.body == draft
    assert wire.wire_hash == policy.wire_hash(draft)


def test_vote_is_transformed_server_side():
    wire = _dispatch("/vote poll-3 yes")
    assert wire.body == "🗳️ poll-3: yes"
    assert wire.kind == "vote"


def test_dispatch_is_exact_first_token_not_prefix():
    """`/votex choice` reaching /vote was a real security bug in the TUI."""
    refusal = _dispatch("/votex choice")
    assert isinstance(refusal, policy.Refusal)
    assert refusal.code == "unknown_command"

    for text in ("/copyx 1", "/imgs /tmp/a.png", "/seenz", "/dr-run"):
        assert _dispatch(text).code == "unknown_command"


def test_non_send_commands_are_refused_with_an_affordance():
    for text in ("/save", "/copy 2", "/seen", "/dr", "/quit", "/img /tmp/a.png"):
        refusal = _dispatch(text)
        assert isinstance(refusal, policy.Refusal)
        assert refusal.code == "command_not_a_send"


def test_vote_usage_error_keeps_the_draft():
    refusal = _dispatch("/vote onlyone")
    assert refusal.code == "bad_command_args"


def test_dr_authority_requires_signed_intent_and_a_live_lease():
    records = {"dr-1": {"dr": "dr-1", "state": "needs_operator_decision"}}
    unsigned = _dispatch("/accept dr-1", dr_records=records)
    assert unsigned.code == "dr_requires_signing"

    dark = _dispatch("/accept dr-1", dr_records=records, intent="signed", armed=False)
    assert dark.code == "signing_unavailable"

    wire = _dispatch("/accept dr-1", dr_records=records, intent="signed", armed=True)
    assert wire.body == "⚖️ DR dr-1 accepted"
    assert wire.kind == "dr_action"


def test_supersede_mirrors_the_projection_preconditions():
    records = {
        "dr-1": {"dr": "dr-1", "state": "ratified"},
        "dr-2": {"dr": "dr-2", "state": "needs_operator_decision"},
    }
    refusal = _dispatch("/supersede dr-1 dr-2", dr_records=records,
                        intent="signed", armed=True)
    assert refusal.code == "dr_invalid_supersede"

    records["dr-2"]["state"] = "ratified"
    wire = _dispatch("/supersede dr-1 dr-2", dr_records=records,
                     intent="signed", armed=True)
    assert wire.body == "⚖️ DR dr-1 superseded by dr-2"


def test_service_observes_only_exact_v2_dr_action(svc, monkeypatch):
    from porch3 import drstore

    log = svc.porch_config.dr_log_path
    action_id = "20250110-184799-000000-abcdef"
    drstore.propose(
        title="v2",
        project="p",
        channel="commons",
        anchor_message_id="anchor-v2",
        path=log,
    )
    monkeypatch.setattr(
        drstore,
        "authentic_action",
        lambda mid, mail_root=None, **kw: (
            ("dr-1", "accepted", None) if mid == action_id else None
        ),
    )
    svc.reload_dr()
    base = {
        "from": svc.porch_config.owner_room,
        "channel": "commons",
        "signature_ref_present": True,
        "signature_ref": {"version": 2, "tag": "ACTION"},
    }
    svc._observe_dr_actions(
        [
            {
                **base,
                "id": "20250110-184798-000000-abcdef",
                "body": "quoted\n⚖️ DR dr-1 accepted",
            }
        ]
    )
    assert not drstore.has_actor_event(
        drstore.replay(log), "20250110-184798-000000-abcdef"
    )

    svc._observe_dr_actions(
        [{**base, "id": action_id, "body": "⚖️ DR dr-1 accepted"}]
    )
    assert svc._dr_records["dr-1"]["state"] == "ratified"
    assert svc._dr_records["dr-1"]["actor_message_id"] == action_id


def test_attachment_paths_are_appended_by_the_server():
    wire = _dispatch("look", attachments=["u1"], spool_paths=["/spool/a.png"])
    assert wire.body == "look\n/spool/a.png"
    assert wire.draft_hash == policy.draft_hash("look", ["u1"])


# ------------------------------------------------------------------ ledger


def _attempt(attempt_id="a1", **kw):
    base = dict(
        device="dev1",
        channel="commons",
        draft_hash="dh",
        wire_hash="wh",
        intent="unsigned",
        request_hash="rh",
    )
    base.update(kw)
    return ledger.Attempt(attempt_id=attempt_id, **base)


def test_ledger_replays_a_committed_attempt(tmp_path):
    attempt = _attempt()
    assert ledger.begin(tmp_path, attempt).kind == "proceed"
    ledger.commit(tmp_path, attempt, ledger.SENT, message_id="m1")

    outcome = ledger.begin(tmp_path, _attempt())
    assert outcome.kind == "replay"
    assert outcome.prior["message_id"] == "m1"


def test_same_attempt_id_different_payload_is_a_conflict(tmp_path):
    attempt = _attempt()
    ledger.begin(tmp_path, attempt)
    ledger.commit(tmp_path, attempt, ledger.SENT, message_id="m1")

    outcome = ledger.begin(tmp_path, _attempt(request_hash="different"))
    assert outcome.kind == "conflict"


def test_a_crash_left_pending_becomes_unknown_and_stays_unknown(tmp_path):
    ledger.begin(tmp_path, _attempt())  # pending, then the process dies

    first = ledger.begin(tmp_path, _attempt())
    assert first.kind == "unknown"
    assert ledger.latest(tmp_path, "a1")["state"] == ledger.UNKNOWN

    again = ledger.begin(tmp_path, _attempt())
    assert again.kind == "unknown"


def test_prune_ages_out_terminal_records_but_never_ambiguous_ones(tmp_path):
    old = _attempt("old")
    ledger.begin(tmp_path, old)
    ledger.commit(tmp_path, old, ledger.SENT, message_id="m", ts=0.0)
    ledger.begin(tmp_path, _attempt("stuck"))  # pending forever

    # Rewrite the sent rows as ancient.
    path = ledger.ledger_path(tmp_path)
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    for row in rows:
        if row["attempt_id"] == "old":
            row["ts"] = 0.0
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))

    assert ledger.prune(tmp_path) == 2
    remaining = {r["attempt_id"] for r in ledger.read_all(tmp_path)}
    assert remaining == {"stuck"}


# ------------------------------------------------------------------ tokens


def test_a_token_of_one_kind_cannot_be_redeemed_as_another(tmp_path):
    token = tokens.mint(tmp_path, "delivery", {"d": "dev"}, 60)
    assert tokens.verify(tmp_path, "delivery", token)["d"] == "dev"
    assert tokens.verify(tmp_path, "image-grant", token) is None


def test_tokens_expire(tmp_path):
    token = tokens.mint(tmp_path, "delivery", {"d": "dev"}, -1)
    assert tokens.verify(tmp_path, "delivery", token) is None


def test_a_tampered_token_fails_the_mac(tmp_path):
    token = tokens.mint(tmp_path, "delivery", {"d": "dev"}, 60)
    head, sig = token.split(".")
    assert tokens.verify(tmp_path, "delivery", f"{head}x.{sig}") is None


# ------------------------------------------------------------------- sends


def test_send_records_the_wire_and_returns_the_message_id(svc, ok_send):
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hey"})
    assert result["ok"] and result["state"] == "sent"
    assert ok_send[0]["text"] == "hey"
    assert ledger.latest(svc.root, "s1")["state"] == ledger.SENT


def test_unsigned_multiline_is_sent_unchanged(svc, ok_send):
    multiline = "line one\nline two"
    result = svc.send(
        "dev1", "commons", {"attempt_id": "s1", "draft_text": multiline}
    )
    assert result["ok"] is True
    assert ok_send[0]["text"] == multiline


def test_a_replayed_send_never_re_invokes_post(svc, ok_send):
    payload = {"attempt_id": "s1", "draft_text": "hey"}
    first = svc.send("dev1", "commons", payload)
    second = svc.send("dev1", "commons", dict(payload))
    assert second["replayed"] is True
    assert second["message_id"] == first["message_id"]
    assert len(ok_send) == 1


def test_idempotency_conflict_on_a_reused_attempt_id(svc, ok_send):
    svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hey"})
    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "different"})
    assert caught.value.code == "idempotency_conflict"
    assert len(ok_send) == 1


def test_signed_intent_while_dark_is_refused_with_the_draft_kept(svc, ok_send):
    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hey",
                                     "intent": "signed"})
    assert caught.value.code == "signing_unavailable"
    assert ledger.latest(svc.root, "s1")["state"] == ledger.REFUSED
    assert not ok_send


def test_decision_send_forwards_configured_dr_log_path(svc, ok_send, add_msg):
    """Regression for 2f911a2: Service.send must pass porch_config.dr_log_path
    into policy.dispatch. Without it, /decision refuses with
    dr_propose_failed ("no DR log path configured") and never writes the log.
    """
    mid = add_msg("commons", 1, "finch", "anchor for decision")
    result = svc.send(
        "dev1",
        "commons",
        {
            "attempt_id": "d1",
            "draft_text": f"/decision {mid} smoke-project harness title",
        },
    )
    assert result["ok"] is True
    dr_id = result.get("dr_event")
    assert isinstance(dr_id, str) and dr_id.startswith("dr-")
    log = svc.porch_config.dr_log_path
    assert log.is_file()
    blob = log.read_text(encoding="utf-8")
    assert dr_id in blob
    assert '"type": "proposed"' in blob or '"type":"proposed"' in blob


def test_unknown_command_is_refused_and_never_broadcast(svc, ok_send):
    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "/votex a"})
    assert caught.value.code == "unknown_command"
    assert not ok_send


def test_committed_output_failure_clears_the_draft_and_warns(svc, monkeypatch):
    monkeypatch.setattr(
        service_mod, "send_as_owner",
        lambda *a, **k: SendResult(ok=False, error_code="delivered_output_failure",
                                   message="spool write failed"),
    )
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hey"})
    assert result["state"] == ledger.COMMITTED_OUTPUT_FAILURE
    assert result["clear_draft"] is True
    assert "do not retry" in result["error"]["message"]


# ------------------------------------------------------- crossed → confirm


@pytest.fixture
def crossed(svc, monkeypatch):
    """First attempt crosses; later sends succeed."""
    state = {"crossed": True, "calls": []}

    def _fake(channel, text, *, raw=False, anyway=False, config=None):
        state["calls"].append({"text": text, "anyway": anyway})
        if state["crossed"] and not anyway:
            return SendResult(ok=False, error_code="crossed_send", message="crossed",
                              missed=[{"id": "m0", "from": "finch", "sent": "", "body": "wait"}])
        return SendResult(ok=True, message="sent", raw={"message": {"id": make_id(95)}})

    monkeypatch.setattr(service_mod, "send_as_owner", _fake)
    return state


def test_crossed_send_bounces_with_a_token_and_keeps_the_draft(svc, crossed):
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "/vote p yes"})
    assert result["state"] == ledger.CROSSED
    assert result["clear_draft"] is False
    assert result["missed"][0]["from"] == "finch"
    assert result["bounce_token"]


def test_confirm_resends_the_expanded_ballot_under_its_own_attempt_id(svc, crossed):
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "/vote p yes"})
    result = svc.confirm("dev1", "commons", {"confirm_attempt_id": "c1",
                                             "bounce_token": bounce["bounce_token"]})
    assert result["ok"] and result["state"] == ledger.SENT
    # The confirm resent the transformed ballot, not the raw slash command.
    assert crossed["calls"][-1] == {"text": "🗳️ p: yes", "anyway": True}
    # The original attempt stays crossed forever.
    assert ledger.latest(svc.root, "s1")["state"] == ledger.CROSSED


def test_a_replayed_confirm_returns_its_prior_result(svc, crossed):
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi"})
    payload = {"confirm_attempt_id": "c1", "bounce_token": bounce["bounce_token"]}
    first = svc.confirm("dev1", "commons", payload)
    second = svc.confirm("dev1", "commons", dict(payload))
    assert second["replayed"] is True
    assert second["message_id"] == first["message_id"]
    assert len([c for c in crossed["calls"] if c["anyway"]]) == 1


def test_a_bounce_token_cannot_be_spent_twice(svc, crossed):
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi"})
    svc.confirm("dev1", "commons", {"confirm_attempt_id": "c1",
                                    "bounce_token": bounce["bounce_token"]})
    with pytest.raises(ApiError) as caught:
        svc.confirm("dev1", "commons", {"confirm_attempt_id": "c2",
                                        "bounce_token": bounce["bounce_token"]})
    assert caught.value.code == "bounce_token_consumed"


def test_a_bounce_token_is_bound_to_its_device(svc, crossed):
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi"})
    with pytest.raises(ApiError) as caught:
        svc.confirm("dev2", "commons", {"confirm_attempt_id": "c1",
                                        "bounce_token": bounce["bounce_token"]})
    assert caught.value.code == "bounce_token_invalid"


def test_signed_confirm_fails_closed_when_the_lease_expires_mid_banner(
    svc, monkeypatch, crossed
):
    monkeypatch.setattr(lease, "is_armed", lambda root: True)
    monkeypatch.setattr(lease, "agent_env", lambda root: {"SSH_AUTH_SOCK": "/dev/null"})
    monkeypatch.setattr(
        service_mod.Signer, "sign_and_send",
        lambda self, channel, text, anyway=False: SendResult(
            ok=False, error_code="crossed_send", message="crossed", missed=[]),
    )
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi",
                                          "intent": "signed"})
    assert bounce["state"] == ledger.CROSSED

    monkeypatch.setattr(lease, "is_armed", lambda root: False)
    with pytest.raises(ApiError) as caught:
        svc.confirm("dev1", "commons", {"confirm_attempt_id": "c1",
                                        "bounce_token": bounce["bounce_token"]})
    assert caught.value.code == "signing_unavailable"
    assert ledger.latest(svc.root, "c1")["state"] == ledger.REFUSED


# --------------------------------------------------------------------- ack


def _page(svc, channel="commons"):
    return svc.messages_page("dev1", channel, None, None)


def test_ack_is_bounded_by_the_served_tip(svc, add_msg, monkeypatch):
    add_msg("commons", 1, "finch", "first")
    add_msg("commons", 2, "finch", "second")
    calls = []
    monkeypatch.setattr(service_mod.postcli, "discard_through",
                        lambda c, m, config=None: calls.append((c, m)) or {"advanced": True})

    page = _page(svc)
    tip = page["tip"]
    assert svc.ack("dev1", "commons", tip, page["delivery_token"])["ok"]
    assert calls == [("commons", tip)]

    with pytest.raises(ApiError) as caught:
        svc.ack("dev1", "commons", "99999999-999999-999999-ffffff",
                page["delivery_token"])
    assert caught.value.code == "ack_beyond_tip"


def test_ack_rejects_another_devices_delivery_token(svc, add_msg):
    add_msg("commons", 1, "finch", "first")
    page = _page(svc)
    with pytest.raises(ApiError) as caught:
        svc.ack("dev2", "commons", page["tip"], page["delivery_token"])
    assert caught.value.code == "delivery_token_invalid"


def test_ack_never_falls_back_to_plain_discard(svc, add_msg, monkeypatch):
    add_msg("commons", 1, "finch", "first")

    def _absent(channel, message_id, config=None):
        raise service_mod.postcli.PostUnavailable("this build of post has no --discard-through")

    monkeypatch.setattr(service_mod.postcli, "discard_through", _absent)
    page = _page(svc)
    with pytest.raises(ApiError) as caught:
        svc.ack("dev1", "commons", page["tip"], page["delivery_token"])
    assert caught.value.code == "discard_through_unavailable"
    assert caught.value.status == 503


# ----------------------------------------------------------------- render


def test_message_json_sanitizes_after_policy(svc, add_msg):
    add_msg("commons", 1, "finch", "🦊 hi \x1b[31mred\x07 @mara [signed:x]")
    message = _page(svc)["messages"][0]
    assert "\x1b" not in message["body"] and "\x07" not in message["body"]
    assert "␛" in message["body"]  # ESC rendered as its control picture
    span = message["mentions"][0]
    assert message["body"][span["start"]:span["end"]] == "@mara"
    assert span["owner"] is True
    assert message["mentions_owner"] is True


def test_message_json_never_strips_authored_v2_marker_bait(svc, add_msg):
    body = "\n🦊🔏 authored [signed:BAIT]\n"
    add_msg(
        "commons",
        2,
        "mara",
        body,
        signature_ref={"version": 2, "tag": "BAIT"},
    )
    message = _page(svc)["messages"][0]
    assert message["body"] == body


def test_day_separators_and_sender_labels(svc, add_msg):
    add_msg("commons", 1, "finch", "hello", display_name="Finch", pfp="🌅")
    message = _page(svc)["messages"][0]
    assert message["day_separator"] is True
    assert message["sender_label"] == "🌅 Finch (finch)"
    assert message["time"] == "18:47"


def test_foreign_images_are_chips_and_own_images_carry_a_grant(svc, add_msg, tmp_path):
    spool = tmp_path / "spool"
    spool.mkdir(exist_ok=True)
    own_path = spool / "photo.png"
    own_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    mid = add_msg("commons", 1, "mara", f"look {own_path} and /elsewhere/foreign.png")

    # Not in the ledger and not live-verified → both candidates are foreign.
    images = _page(svc)["messages"][0]["images"]
    assert [i["kind"] for i in images] == ["foreign", "foreign"]
    assert all("grant" not in i for i in images)

    # Committed in porchd's own ledger → the spool candidate becomes own.
    attempt = _attempt("own1")
    ledger.begin(svc.root, attempt)
    ledger.commit(svc.root, attempt, ledger.SENT, message_id=mid)
    images = _page(svc)["messages"][0]["images"]
    assert images[0]["kind"] == "own" and images[0]["grant"]
    assert images[1]["kind"] == "foreign" and "grant" not in images[1]
    assert images[0]["name"] == "photo.png"


def test_from_trey_alone_never_makes_a_message_own(svc, add_msg, tmp_path):
    spool = tmp_path / "spool"
    spool.mkdir(exist_ok=True)
    path = spool / "forged.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n")
    add_msg("commons", 1, "mara", f"totally mine {path}")
    assert _page(svc)["messages"][0]["images"][0]["kind"] == "foreign"


# ----------------------------------------------------------------- images


def _png_bytes(size=(8, 8)):
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def _upload(svc):
    return svc.upload_image("dev1", _png_bytes(), "image/png")["upload_id"]


def test_upload_is_validated_spooled_and_consumed_once(svc, tmp_path, ok_send):
    upload = svc.upload_image("dev1", _png_bytes(), "image/png")
    upload_id = upload["upload_id"]

    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                          "attachments": [upload_id]})
    assert result["ok"]
    assert ok_send[0]["text"].startswith("look\n")
    assert str(tmp_path / "spool") in ok_send[0]["text"]

    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s2", "draft_text": "again",
                                     "attachments": [upload_id]})
    assert caught.value.code == "upload_consumed"


def test_upload_rejects_a_non_image_body(svc):
    with pytest.raises(ApiError) as caught:
        svc.upload_image("dev1", b"not an image at all", "image/png")
    assert caught.value.code == "invalid_image"


def test_an_upload_id_is_bound_to_its_device(svc):
    upload_id = svc.upload_image("dev1", _png_bytes(), "image/png")["upload_id"]
    with pytest.raises(ApiError) as caught:
        svc.send("dev2", "commons", {"attempt_id": "s1", "draft_text": "x",
                                     "attachments": [upload_id]})
    assert caught.value.code == "upload_expired"


def test_reveal_mints_a_grant_that_serves_only_a_thumbnail(svc, add_msg, tmp_path,
                                                           monkeypatch):
    monkeypatch.setenv("PORCHD_REVEAL_ROOTS", str(tmp_path))
    foreign = tmp_path / "foreign.png"
    foreign.write_bytes(_png_bytes((2000, 1200)))
    mid = add_msg("commons", 1, "finch", f"see {foreign}")
    _page(svc)  # load the channel

    grant = svc.reveal_image("dev1", mid, 0)["grant"]
    body = svc.image_bytes("dev1", grant)
    assert body[:8] == b"\x89PNG\r\n\x1a\n"

    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(body)) as thumb:
        assert thumb.size[0] <= 640 and thumb.size[1] <= 480


def test_a_grant_is_bound_to_its_device_and_expires(svc, tmp_path, monkeypatch):
    monkeypatch.setenv("PORCHD_REVEAL_ROOTS", str(tmp_path))
    image = tmp_path / "a.png"
    image.write_bytes(_png_bytes())
    grant = imagesvc.mint_grant(svc.root, device="dev1", message_id="m", index=0,
                                path=image)
    assert svc.image_bytes("dev1", grant)

    with pytest.raises(ApiError) as caught:
        svc.image_bytes("dev2", grant)
    assert caught.value.code == "grant_invalid"

    stale = imagesvc.mint_grant(svc.root, device="dev1", message_id="m", index=0,
                                path=image, ttl_s=-1)
    with pytest.raises(ApiError):
        svc.image_bytes("dev1", stale)


def test_reveal_refuses_a_path_outside_the_boundary(svc, add_msg, tmp_path, monkeypatch):
    monkeypatch.setenv("PORCHD_REVEAL_ROOTS", str(tmp_path / "allowed"))
    (tmp_path / "allowed").mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(_png_bytes())
    mid = add_msg("commons", 1, "finch", f"see {outside}")
    _page(svc)

    with pytest.raises(ApiError) as caught:
        svc.reveal_image("dev1", mid, 0)
    assert caught.value.code == "path_refused"


# --------------------------------------------------------- activity lease


def test_auto_join_only_happens_under_an_activity_lease(svc, joins):
    joins.clear()
    svc.refresh_channels(join=svc.activity_leased())
    assert joins == []  # nobody has polled: read-only discovery

    svc.note_activity()
    svc.refresh_channels(join=svc.activity_leased())
    assert sorted(joins) == ["backporch", "commons"]

    joins.clear()
    svc._last_activity = 0.0
    svc.refresh_channels(join=svc.activity_leased())
    assert joins == []  # the lease lapsed again


def test_unknown_channels_are_refused_not_path_joined(svc):
    for bad in ("../../etc", "nope", "commons/../backporch", ""):
        with pytest.raises(ApiError) as caught:
            svc.known_channel(bad)
        assert caught.value.code == "no_such_channel"


def test_transcript_matches_the_save_format(svc, add_msg):
    mid = add_msg("commons", 1, "finch", "hello there")
    text = svc.transcript("commons")
    assert text.startswith(f"--- finch   2025-01-10 18:47:42 -0500   {mid}")
    assert "hello there" in text


# ------------------------------------------------- upload state machine (§5)


def test_a_crossed_send_keeps_the_attachment_chip_alive(svc, crossed):
    """Consuming at wire assembly killed the chip of a draft still on screen."""
    upload_id = _upload(svc)
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                          "attachments": [upload_id]})
    assert result["state"] == ledger.CROSSED
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.RESERVED_FOR_CONFIRM

    # Held for THIS bounce: another draft cannot steal it meanwhile.
    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s2", "draft_text": "other",
                                     "attachments": [upload_id]})
    assert caught.value.code == "upload_reserved"


def test_confirm_inherits_the_reservation_and_consumes_on_commit(svc, crossed):
    upload_id = _upload(svc)
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                          "attachments": [upload_id]})
    result = svc.confirm("dev1", "commons", {"confirm_attempt_id": "c1",
                                             "bounce_token": bounce["bounce_token"]})
    assert result["ok"]
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.CONSUMED
    assert ledger.latest(svc.root, "c1")["state"] == ledger.SENT


def test_keep_editing_releases_the_chip_for_a_fresh_attempt(svc, crossed):
    upload_id = _upload(svc)
    bounce = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                          "attachments": [upload_id]})
    released = svc.dismiss("dev1", "commons", {"bounce_token": bounce["bounce_token"]})
    assert released == {"ok": True, "released": 1}
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.AVAILABLE

    crossed["crossed"] = False
    again = svc.send("dev1", "commons", {"attempt_id": "s2", "draft_text": "look, edited",
                                         "attachments": [upload_id]})
    assert again["ok"]
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.CONSUMED


def test_an_uncommitted_failure_releases_the_chip(svc, monkeypatch):
    monkeypatch.setattr(
        service_mod, "send_as_owner",
        lambda *a, **k: SendResult(ok=False, error_code="send_failed", message="SEND FAILED"),
    )
    upload_id = _upload(svc)
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                          "attachments": [upload_id]})
    assert result["state"] == ledger.REFUSED
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.AVAILABLE


def test_a_refusal_before_post_releases_the_chip(svc, ok_send):
    upload_id = _upload(svc)
    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "/votex nope",
                                     "attachments": [upload_id]})
    assert caught.value.code == "unknown_command"
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.AVAILABLE
    assert not ok_send


def test_a_committed_output_failure_consumes_the_chip(svc, monkeypatch):
    monkeypatch.setattr(
        service_mod, "send_as_owner",
        lambda *a, **k: SendResult(ok=False, error_code="delivered_output_failure",
                                   message="spool write failed"),
    )
    upload_id = _upload(svc)
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                          "attachments": [upload_id]})
    assert result["state"] == ledger.COMMITTED_OUTPUT_FAILURE
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.CONSUMED


def test_an_ambiguous_outcome_makes_the_chip_unknown_and_unreusable(svc, ok_send):
    upload_id = _upload(svc)
    payload = {"attempt_id": "s1", "draft_text": "look", "attachments": [upload_id]}

    # Simulate a crash between the pending write and the post call.
    attempt = ledger.Attempt(
        attempt_id="s1", device="dev1", channel="commons",
        draft_hash=policy.draft_hash("look", [upload_id]), wire_hash="",
        intent="unsigned",
        request_hash=ledger.request_hash(channel="commons", draft_text="look",
                                         attachments=[upload_id], intent="unsigned"),
    )
    ledger.begin(svc.root, attempt)
    imagesvc.reserve(svc.root, device="dev1", upload_ids=[upload_id], attempt_id="s1")

    result = svc.send("dev1", "commons", payload)
    assert result["error"]["code"] == "outcome_unknown"
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.UNKNOWN
    assert not ok_send  # never auto-resent

    with pytest.raises(ApiError) as caught:
        svc.send("dev1", "commons", {"attempt_id": "s2", "draft_text": "look",
                                     "attachments": [upload_id]})
    assert caught.value.code == "upload_unknown"


def test_reserving_twice_for_the_same_attempt_is_idempotent(svc):
    upload_id = _upload(svc)
    first = imagesvc.reserve(svc.root, device="dev1", upload_ids=[upload_id], attempt_id="s1")
    second = imagesvc.reserve(svc.root, device="dev1", upload_ids=[upload_id], attempt_id="s1")
    assert first == second
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.RESERVED


def test_reserve_is_all_or_nothing(svc):
    good, taken = _upload(svc), _upload(svc)
    imagesvc.reserve(svc.root, device="dev1", upload_ids=[taken], attempt_id="other")
    with pytest.raises(imagesvc.ImageError):
        imagesvc.reserve(svc.root, device="dev1", upload_ids=[good, taken], attempt_id="s1")
    # The first id must not have been left half-reserved.
    assert imagesvc.state_of(svc.root, good) == imagesvc.AVAILABLE


def test_an_abandoned_bounce_releases_once_confirm_is_provably_closed(svc, crossed):
    upload_id = _upload(svc)
    svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "look",
                                 "attachments": [upload_id]})
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.RESERVED_FOR_CONFIRM

    # Past the bounce token's own expiry no confirm can spend it, so a new
    # attempt may take it — the tab closing must not strand the chip forever.
    later = time.time() + service_mod.BOUNCE_TOKEN_TTL_S + 1
    imagesvc.reserve(svc.root, device="dev1", upload_ids=[upload_id],
                     attempt_id="s2", now=later)
    assert imagesvc.state_of(svc.root, upload_id) == imagesvc.RESERVED


def test_expiry_deletes_available_uploads_only(svc, tmp_path):
    stale, held, ambiguous = _upload(svc), _upload(svc), _upload(svc)
    imagesvc.reserve(svc.root, device="dev1", upload_ids=[held], attempt_id="s1")
    imagesvc.mark_unknown(svc.root, upload_ids=[ambiguous], attempt_id="s0")
    paths = {
        name: Path(imagesvc._load_uploads(svc.root)[name]["path"])
        for name in (stale, held, ambiguous)
    }

    later = time.time() + imagesvc.UPLOAD_TTL_S + 1
    assert imagesvc.prune_uploads(svc.root, spool_dir=tmp_path / "spool", now=later) == 1
    assert not paths[stale].exists()
    assert paths[held].exists() and paths[ambiguous].exists()
    assert imagesvc.state_of(svc.root, held) == imagesvc.RESERVED
    assert imagesvc.state_of(svc.root, ambiguous) == imagesvc.UNKNOWN


# ------------------------------------------------- canonical hashing (§7)


def test_hashes_are_not_textual_concatenation(svc):
    """Concatenation let a draft's tail masquerade as an attachment id."""
    assert policy.draft_hash("a", ["b", "c"]) != policy.draft_hash("a\x00b", ["c"])
    assert policy.draft_hash("a", ["bc"]) != policy.draft_hash("ab", ["c"])
    assert policy.draft_hash("", ["a"]) != policy.draft_hash("a", [])


def test_draft_and_wire_hashes_live_in_different_domains():
    assert policy.wire_hash("x") != policy.draft_hash("x", [])


def test_request_hash_separates_field_boundaries():
    common = {"intent": "unsigned"}
    first = ledger.request_hash(channel="a", draft_text="b", attachments=[], **common)
    second = ledger.request_hash(channel="ab", draft_text="", attachments=[], **common)
    assert first != second


# ------------------------------------------------- post --discard-through


def _fake_post(monkeypatch, stdout, returncode=0):
    import subprocess

    from porchd import postcli

    def _run(args, **kwargs):
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    monkeypatch.setattr(postcli.subprocess, "run", _run)


def test_discard_through_maps_the_live_envelope(monkeypatch, tmp_path):
    """Field names pinned against the real binary (prior_cursor / cursor)."""
    from porchd import postcli

    cfg = make_porch_config(tmp_path)
    _fake_post(monkeypatch, json.dumps({
        "ok": True, "channel": "commons", "room": "mara",
        "target": "m2", "prior_cursor": "m1", "cursor": "m2",
        "advanced": True, "discarded": 3,
    }))
    assert postcli.discard_through("commons", "m2", config=cfg) == {
        "advanced": True, "prior": "m1", "cursor": "m2", "discarded": 3
    }


def test_a_replayed_ack_is_success_with_advanced_false(monkeypatch, tmp_path):
    from porchd import postcli

    cfg = make_porch_config(tmp_path)
    _fake_post(monkeypatch, json.dumps({
        "ok": True, "target": "m1", "prior_cursor": "m1", "cursor": "m1",
        "advanced": False, "discarded": 0,
    }))
    result = postcli.discard_through("commons", "m1", config=cfg)
    assert result["advanced"] is False and result["cursor"] == "m1"


def test_a_refused_target_raises_rather_than_advancing(monkeypatch, tmp_path):
    from porchd import postcli

    cfg = make_porch_config(tmp_path)
    _fake_post(monkeypatch, json.dumps({
        "ok": False,
        "error": {"code": "no_such_message",
                  "message": "no message in channel 'commons' matching id"},
    }), returncode=1)
    with pytest.raises(postcli.PostUnavailable) as caught:
        postcli.discard_through("commons", "from-another-channel", config=cfg)
    assert "no message in channel" in str(caught.value)


def test_an_absent_flag_never_degrades_to_plain_discard(monkeypatch, tmp_path):
    from porchd import postcli

    cfg = make_porch_config(tmp_path)
    _fake_post(monkeypatch, "error: unrecognized arguments: --discard-through", returncode=2)
    with pytest.raises(postcli.PostUnavailable) as caught:
        postcli.discard_through("commons", "m1", config=cfg)
    assert "--discard-through" in str(caught.value)


# --------------------------------------- client-lane wire reconciliation


def test_missed_messages_get_the_full_message_shape(svc, crossed, add_msg):
    """The bounce banner is the reason to reconsider — it earns real parity."""
    add_msg("commons", 1, "finch", "hello")
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "mine"})
    missed = result["missed"][0]
    # The reduced shape the client already renders is still present…
    assert {"id", "from", "time", "body"} <= set(missed)
    # …plus everything a normal message carries.
    assert {"color", "mentions", "verify", "dr", "reply", "sender_label"} <= set(missed)


def test_missed_bodies_are_sanitized_and_stripped_of_the_wire_format(svc, monkeypatch):
    def _crossing(channel, text, *, raw=False, anyway=False, config=None):
        return SendResult(
            ok=False, error_code="crossed_send", message="crossed",
            missed=[{"id": make_id(3), "from": "finch", "sent": "2025-01-10 18:47:42 -0500",
                     "body": "🦊🔏 careful \x1b[31mred @mara [signed:20250110T000000Z]"}],
        )

    monkeypatch.setattr(service_mod, "send_as_owner", _crossing)
    result = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "mine"})
    body = result["missed"][0]["body"]
    assert "\x1b" not in body and "␛" in body  # P6: sanitized before serialization
    assert body.startswith("careful")  # prefix and [signed:] tag stripped
    assert "[signed:" not in body
    assert result["missed"][0]["mentions"][0]["owner"] is True


def test_an_incremental_page_does_not_invent_a_day_separator(svc, add_msg):
    first = add_msg("commons", 1, "finch", "morning")
    add_msg("commons", 2, "finch", "still morning")

    full = _page(svc)["messages"]
    assert [m["day_separator"] for m in full] == [True, False]

    # Polling with ?after= must not redraw the rule mid-day.
    incremental = svc.messages_page("dev1", "commons", first, None)["messages"]
    assert [m["day_separator"] for m in incremental] == [False]


def test_a_new_day_still_separates_across_an_incremental_page(svc, add_msg):
    first = add_msg("commons", 1, "finch", "yesterday")
    add_msg("commons", 2, "finch", "today", sent="2025-01-11 09:00:00 -0500")
    incremental = svc.messages_page("dev1", "commons", first, None)["messages"]
    assert incremental[0]["day_separator"] is True


def test_a_sent_response_states_whether_the_server_signed_it(svc, ok_send, monkeypatch):
    unsigned = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi"})
    assert unsigned["signed"] is False

    monkeypatch.setattr(lease, "is_armed", lambda root: True)
    monkeypatch.setattr(lease, "agent_env", lambda root: {"SSH_AUTH_SOCK": "/dev/null"})
    monkeypatch.setattr(
        service_mod.Signer, "sign_and_send",
        lambda self, channel, text, anyway=False: SendResult(
            ok=True, message="sent", raw={"message": {"id": make_id(99)}}),
    )
    signed = svc.send("dev1", "commons", {"attempt_id": "s2", "draft_text": "hi",
                                          "intent": "signed"})
    assert signed["signed"] is True


def test_signed_send_refuses_when_the_socket_vanishes_after_precheck(svc, monkeypatch):
    """TOCTOU: is_armed true, then the service socket disappears before
    _execute. env=None must never reach a Signer — subprocess would inherit
    porchd's ambient SSH_AUTH_SOCK and sign through an unrelated agent."""
    monkeypatch.setattr(lease, "is_armed", lambda root: True)
    monkeypatch.setattr(lease, "agent_env", lambda root: None)

    def _no_signer(*a, **k):
        raise AssertionError("Signer constructed with a dark lease")

    monkeypatch.setattr(service_mod, "Signer", _no_signer)
    monkeypatch.setattr(
        service_mod, "send_as_owner",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("unsigned fallback ran")),
    )

    response = svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi",
                                            "intent": "signed"})
    assert response["ok"] is False
    assert response["state"] == ledger.REFUSED
    assert response["clear_draft"] is False
    assert response["error"]["code"] == "sign_failed"
    assert ledger.latest(svc.root, "s1")["state"] == ledger.REFUSED


def test_signed_multiline_preserves_the_exact_mobile_body(svc, monkeypatch):
    multiline = " \tfirst\r\n\rsecond\n\u2028👩‍🚀🦊🔏 [signed:BAIT]\t\n"
    monkeypatch.setattr(lease, "is_armed", lambda root: True)
    monkeypatch.setattr(
        lease, "agent_env", lambda root: {"SSH_AUTH_SOCK": "/dev/null"}
    )

    captured = []

    def signed_send(self, channel, text, **kwargs):
        captured.append(text)
        return SendResult(ok=True, message="sent", raw={"message": {"id": "m1"}})

    monkeypatch.setattr(signer_mod.Signer, "sign_and_send", signed_send)

    response = svc.send(
        "dev1",
        "commons",
        {"attempt_id": "s1", "draft_text": multiline, "intent": "signed"},
    )

    assert response["ok"] is True
    assert response["clear_draft"] is True
    assert captured == [multiline]
    assert ledger.latest(svc.root, "s1")["state"] == ledger.SENT


def test_signed_over_cap_keeps_the_mobile_draft_without_io(svc, monkeypatch):
    draft = "x" * (MAX_SIGNED_BODY_BYTES + 1)
    monkeypatch.setattr(lease, "is_armed", lambda root: True)
    monkeypatch.setattr(
        lease, "agent_env", lambda root: {"SSH_AUTH_SOCK": "/dev/null"}
    )

    def forbidden(*args, **kwargs):
        raise AssertionError("over-cap refusal must precede sidecars and processes")

    monkeypatch.setattr(signer_mod, "_create_payload", forbidden)
    monkeypatch.setattr(signer_mod.subprocess, "run", forbidden)
    monkeypatch.setattr(signer_mod, "send_as_owner", forbidden)
    response = svc.send(
        "dev1",
        "commons",
        {"attempt_id": "over", "draft_text": draft, "intent": "signed"},
    )

    assert response["ok"] is False
    assert response["state"] == ledger.REFUSED
    assert response["clear_draft"] is False
    assert response["error"]["code"] == "sign_failed"
    assert "1,048,576-byte limit" in response["error"]["message"]
    assert not svc.porch_config.sigs_dir.exists()


def test_the_reveal_denylist_covers_secrets_state_and_the_mail_corpus(svc, tmp_path):
    """Denied even when the path sits inside an allowed reveal root."""
    from porchd.imagesvc import _confined
    from porchd.state import default_root

    home = Path.home()
    room = svc.porch_config.owner_room_dir
    mail = svc.porch_config.mail_root
    kw = dict(owner_room_dir=room, mail_root=mail)
    for denied in (
        home / ".ssh" / "id_ed25519",
        home / ".gnupg" / "secring.gpg",
        room / "mara_porch_key",
        home / "Library" / "Keychains" / "login.keychain-db",
        default_root() / "devices.json",
        mail / "channels" / "commons" / "messages" / "x.png",
    ):
        assert _confined(denied, **kw) is False, denied

    # A perfectly ordinary path under home still resolves.
    assert _confined(home / "Code" / "somewhere" / "shot.png", **kw) is True


def test_reveal_denies_an_explicit_key_file_outside_the_room(svc, tmp_path):
    """SECURITY (item 21): key_file may be configured outside owner_room_dir
    (B0 permits an absolute override); the reveal boundary must still deny
    it and its .pub, not just the room directory it happens to omit."""
    from porchd.imagesvc import _confined

    outside_room = tmp_path / "elsewhere" / "id_ed25519"
    outside_room.parent.mkdir(parents=True, exist_ok=True)
    outside_room.write_text("fake key material")
    pub = Path(str(outside_room) + ".pub")
    pub.write_text("fake pub material")

    kw = dict(
        owner_room_dir=svc.porch_config.owner_room_dir,
        mail_root=svc.porch_config.mail_root,
        state_root=svc.root,
        key_file=outside_room,
    )
    assert _confined(outside_room, **kw) is False
    assert _confined(pub, **kw) is False
    # Exact key path (+.pub) is denied; a sibling under an allowed reveal
    # root is not swept in by the key_file entry.
    sibling = Path.home() / "Code" / "somewhere" / "shot.png"
    assert _confined(sibling, **kw) is True


def test_reveal_image_refuses_a_key_file_outside_the_room(svc, monkeypatch, tmp_path, add_msg):
    """End-to-end: Service.reveal_image threads porch_config.key_file into
    the confinement check. The candidate scan only ever surfaces
    image-suffixed paths (§5), so this is the literal "image-shaped
    private-key path" attack the brief names — a private key with a
    disguised image extension outside the room must still be denied, even
    though the path sits inside the (widened, for this test) reveal roots."""
    from dataclasses import replace

    monkeypatch.setenv("PORCHD_REVEAL_ROOTS", str(tmp_path))
    outside_key = tmp_path / "outside" / "mara_porch_key.png"
    outside_key.parent.mkdir(parents=True, exist_ok=True)
    outside_key.write_text("fake key material")

    svc.porch_config = replace(svc.porch_config, key_file=outside_key)
    mid = add_msg("commons", 1, "finch", f"see {outside_key}")
    _page(svc)

    with pytest.raises(ApiError) as ei:
        svc.reveal_image("dev1", mid, 0)
    assert ei.value.code == "path_refused"


def test_the_state_root_is_denied_even_when_relocated(svc, tmp_path, monkeypatch):
    from porchd.imagesvc import _confined

    relocated = tmp_path / "elsewhere-state"
    relocated.mkdir()
    monkeypatch.setenv("PORCHD_STATE_ROOT", str(relocated))
    monkeypatch.setenv("PORCHD_REVEAL_ROOTS", str(tmp_path))
    kw = dict(
        owner_room_dir=svc.porch_config.owner_room_dir,
        mail_root=svc.porch_config.mail_root,
        state_root=relocated,
    )
    assert _confined(relocated / "attempts.jsonl", **kw) is False
    assert _confined(tmp_path / "ok.png", **kw) is True


# --------------------------------------- interprocess operation lock (§3)


def test_a_terminal_lock_cannot_land_mid_send(svc, tmp_path, monkeypatch):
    """arm/lock run in ANOTHER process; an in-process lock cannot see them."""
    import subprocess
    import sys
    import threading

    marker = tmp_path / "lock-landed"
    in_post = threading.Event()
    finish = threading.Event()
    completed: dict = {}

    monkeypatch.setattr(lease, "is_armed", lambda root: True)
    monkeypatch.setattr(lease, "agent_env", lambda root: {"SSH_AUTH_SOCK": "/dev/null"})

    def _slow_sign(self, channel, text, anyway=False):
        in_post.set()
        finish.wait(10)
        return SendResult(ok=True, message="sent", raw={"message": {"id": make_id(97)}})

    monkeypatch.setattr(service_mod.Signer, "sign_and_send", _slow_sign)

    def _send():
        completed["result"] = svc.send(
            "dev1", "commons",
            {"attempt_id": "s1", "draft_text": "hi", "intent": "signed"},
        )
        completed["at"] = time.time()

    sender = threading.Thread(target=_send)
    sender.start()
    assert in_post.wait(5), "the send never reached the signer"

    # A real second process, exactly as `porch-mobile lock` would be.
    script = (
        "import time, sys, pathlib\n"
        "from porchd import lease\n"
        f"lease.lock(pathlib.Path({str(svc.root)!r}))\n"
        f"pathlib.Path({str(marker)!r}).write_text(str(time.time()))\n"
    )
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}
    locker = subprocess.Popen([sys.executable, "-c", script], env=env)
    try:
        # While the send holds the queue, the terminal lock must wait.
        time.sleep(1.0)
        assert not marker.exists(), "a terminal lock landed in the middle of a send"
        assert locker.poll() is None

        finish.set()
        sender.join(10)
        assert locker.wait(10) == 0
    finally:
        finish.set()
        if locker.poll() is None:
            locker.kill()
        sender.join(5)

    # The send completed signed, and the lock took effect only afterwards.
    assert completed["result"]["ok"] and completed["result"]["signed"] is True
    assert float(marker.read_text()) >= completed["at"]


def test_the_operation_lock_is_reentrant_within_a_thread(svc):
    """signing_lock holds the queue and then calls lease.lock, which retakes it."""
    from porchd.oplock import operation_lock

    with operation_lock(svc.root, timeout=1):
        with operation_lock(svc.root, timeout=1):
            pass
        assert svc.signing_lock()["ok"] is True


def test_a_send_refuses_rather_than_hanging_on_a_held_queue(svc, ok_send, tmp_path, monkeypatch):
    """A passphrase prompt left open at the Mac must not freeze the phone."""
    import subprocess
    import sys

    monkeypatch.setattr(service_mod, "OPERATION_TIMEOUT_S", 0.5)
    holding = tmp_path / "queue-held"
    script = (
        "import time, pathlib\n"
        "from porchd.oplock import operation_lock\n"
        f"with operation_lock(pathlib.Path({str(svc.root)!r})):\n"
        f"    pathlib.Path({str(holding)!r}).write_text('held')\n"
        "    time.sleep(30)\n"
    )
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src")}
    holder = subprocess.Popen([sys.executable, "-c", script], env=env)
    try:
        deadline = time.time() + 15
        while not holding.exists() and time.time() < deadline:
            time.sleep(0.02)
        assert holding.exists(), "the holder never took the queue"

        with pytest.raises(ApiError) as caught:
            svc.send("dev1", "commons", {"attempt_id": "s1", "draft_text": "hi"})
        assert caught.value.code == "operation_busy"
        assert caught.value.status == 503
    finally:
        holder.kill()
        holder.wait(5)
    assert not ok_send  # refused before post, so nothing was sent
    assert ledger.latest(svc.root, "s1") is None  # and before the ledger too
