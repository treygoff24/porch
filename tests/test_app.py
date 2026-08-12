"""Headless Textual Pilot tests for porch3 UI flows."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from porch3.app import PorchApp
from helpers import make_porch_config
from porch3.images import spool_image
from porch3.send import SendResult
from porch3.signer import Signer
from porch3 import verify as verify_mod
from porch3.widgets.composer import Composer
from porch3.widgets.message_list import MessageList
from porch3.widgets.channel_browser import ChannelBrowser
from porch3.widgets.bounce import BounceBanner, BOUNCE_TITLE
from porch3.widgets.message_block import MessageBlock


def _seed_channel(root: Path, name: str = "commons", n: int = 3) -> None:
    store = root / name / "messages"
    store.mkdir(parents=True, exist_ok=True)
    (root / name / "channel.json").write_text(
        json.dumps({"name": name, "description": f"{name} norms"})
    )
    (root / name / "members.json").write_text(
        json.dumps({"mara": "2025-01-01", "juniper": "2025-01-01"})
    )
    for i in range(n):
        mid = f"20250106-12000{i}-000000-aaaaa{i}"
        meta = {
            "id": mid,
            "from": "juniper" if i % 2 == 0 else "mara",
            "sent": f"2025-01-06 12:0{i}:00 -0400",
            "mentions": ["mara"] if i == 1 else [],
        }
        body = f"hello @{ 'mara' if i == 1 else 'juniper' } message {i}"
        (store / f"{mid}.msg").write_text(json.dumps(meta) + "\n---\n" + body + "\n")


@pytest.fixture
def channel_root(tmp_path: Path) -> Path:
    _seed_channel(tmp_path, "commons")
    _seed_channel(tmp_path, "workbench", n=1)
    return tmp_path



def _make_app(channel_root: Path, *, signer=None, channel="commons", skip_join=True, **kw):
    cfg = make_porch_config(channel_root)
    return PorchApp(
        porch_config=cfg,
        channel=channel,
        signer=signer or Signer(cfg),
        channels_root=channel_root,
        skip_join=skip_join,
        **kw,
    )


def _tiny_png(path: Path) -> Path:
    from PIL import Image

    Image.new("RGB", (1, 1), (255, 0, 0)).save(path)
    return path


async def test_composer_multiline_and_paste_not_send(channel_root: Path):
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        composer = app.query_one("#composer", Composer)
        await pilot.click("#composer")
        await pilot.press("h", "i")
        # Shift+Enter inserts newline without submitting
        await pilot.press("shift+enter")
        await pilot.press("t", "h", "e", "r", "e")
        assert "hi\nthere" in composer.text.replace("\r\n", "\n")
        # Paste with newlines must not submit
        from textual.events import Paste

        composer.post_message(Paste("line1\nline2\nline3"))
        await pilot.pause()
        assert "line1\nline2\nline3" in composer.text.replace("\r\n", "\n")
        # Still in chat — no quit, draft preserved
        assert app.mode == "chat"


async def test_channel_browser_population(channel_root: Path):
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.channels == ["commons", "workbench"]
        # Empty composer + Left opens browser
        await pilot.press("left")
        await pilot.pause()
        assert app.mode == "channels"
        browser = app.query_one("#browser", ChannelBrowser)
        assert "commons" in browser.channels
        assert "workbench" in browser.channels
        # Description rendered under name (plain Text, markup=False)
        desc_plain = []
        for w in browser.query(".chan-desc"):
            r = getattr(w, "renderable", None)
            if hasattr(r, "plain"):
                desc_plain.append(r.plain)
            elif getattr(w, "content", None):
                desc_plain.append(str(w.content))
            else:
                desc_plain.append(str(w.render()))
        assert any("norms" in d for d in desc_plain)


async def test_browsing_css_toggles_computed_visibility(channel_root: Path):
    """Finding 1: class selector .-browsing must flip pane display."""
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        chat = app.query_one("#chat-pane")
        browser = app.query_one("#browser-pane")
        assert chat.styles.display == "block"
        assert browser.styles.display == "none"

        await pilot.press("left")
        await pilot.pause()
        assert app.mode == "channels"
        assert app.has_class("-browsing")
        assert chat.styles.display == "none"
        assert browser.styles.display == "block"

        await pilot.press("right")
        await pilot.pause()
        assert app.mode == "chat"
        assert not app.has_class("-browsing")
        assert chat.styles.display == "block"
        assert browser.styles.display == "none"


async def test_verify_badge_updates_mounted_block(channel_root: Path):
    """Finding 2: pending→✓ and pending→✗ refresh an already-mounted header."""
    verify_mod.VERIFY_CACHE.clear()
    store = channel_root / "commons" / "messages"
    mid_ok = "20250106-130000-000000-sigok1"
    mid_bad = "20250106-130001-000000-sigbad"
    for mid, body in (
        (mid_ok, "🦊🔏 hello [signed:20250106T130000Z]"),
        (mid_bad, "🦊🔏 nope [signed:20250106T130001Z]"),
    ):
        meta = {
            "id": mid,
            "from": "mara",
            "sent": "2025-01-06 13:00:00 -0400",
        }
        (store / f"{mid}.msg").write_text(json.dumps(meta) + "\n---\n" + body + "\n")

    app = _make_app(channel_root)
    # Do not let the real worker race the assertion — start pending in cache
    # Patch the name the app actually calls (imported directly into app.py) —
    # patching porch3.verify would leave the real worker racing the assertion.
    with patch("porch3.app.enqueue_verifications"):
        async with app.run_test() as pilot:
            await pilot.pause()
            # Force pending state on mounted blocks
            verify_mod.VERIFY_CACHE.pop(mid_ok, None)
            verify_mod.VERIFY_CACHE.pop(mid_bad, None)
            messages = app.query_one("#messages", MessageList)
            block_ok = messages._blocks_by_id[mid_ok]
            block_bad = messages._blocks_by_id[mid_bad]
            block_ok.refresh_verify_badge()
            block_bad.refresh_verify_badge()
            await pilot.pause()
            assert "…" in block_ok._header_text().plain
            assert "…" in block_bad._header_text().plain

            verify_mod.apply_verify_result(mid_ok, " 🔏✓")
            app._on_verify_done(mid_ok, " 🔏✓")
            await pilot.pause()
            assert "✓" in block_ok._header_text().plain
            assert "…" not in block_ok._header_text().plain

            verify_mod.apply_verify_result(mid_bad, " 🔏✗UNVERIFIED")
            app._on_verify_done(mid_bad, " 🔏✗UNVERIFIED")
            await pilot.pause()
            assert "✗" in block_bad._header_text().plain
    verify_mod.VERIFY_CACHE.clear()


async def test_bounce_flow_keeps_draft(channel_root: Path):
    app = _make_app(channel_root)
    missed = [
        {
            "id": "m1",
            "from": "juniper",
            "sent": "2025-01-06 12:30:00 -0400",
            "body": "landed first",
            "mentions": [],
        }
    ]
    crossed = SendResult(
        ok=False,
        error_code="crossed_send",
        message="crossed",
        missed=missed,
    )
    ok = SendResult(ok=True, message="sent")
    calls = {"n": 0}

    def fake_send(*_a, **kwargs):
        calls["n"] += 1
        # First two attempts bounce; anyway=True succeeds
        if kwargs.get("anyway"):
            return ok
        return crossed

    async with app.run_test() as pilot:
        import porch3.send as send_mod

        with patch.object(send_mod, "send_as_owner", side_effect=fake_send):
            composer = app.query_one("#composer", Composer)
            await pilot.click("#composer")
            await pilot.press("d", "r", "a", "f", "t")
            await pilot.press("enter")
            await pilot.pause()
            bounce = app.query_one("#bounce", BounceBanner)
            assert bounce.active
            assert "draft" in composer.text
            # Banner wording is cursor-honest, not "while you typed"
            assert "while you typed" not in BOUNCE_TITLE
            assert "unseen" in BOUNCE_TITLE
            # Esc dismisses, keeps draft
            await pilot.press("escape")
            await pilot.pause()
            assert not bounce.active
            assert "draft" in composer.text

            # Send again → bounce → Enter anyway
            await pilot.press("enter")
            await pilot.pause()
            assert bounce.active
            await pilot.press("enter")
            await pilot.pause()
            assert calls["n"] >= 2
            assert not bounce.active


async def test_bounce_edited_composer_sends_current_not_stale(channel_root: Path):
    """Finding 3: edited draft while banner up → normal send of current text."""
    app = _make_app(channel_root)
    missed = [
        {
            "id": "m1",
            "from": "juniper",
            "sent": "2025-01-06 12:30:00 -0400",
            "body": "landed first",
            "mentions": [],
        }
    ]
    crossed = SendResult(
        ok=False, error_code="crossed_send", message="crossed", missed=missed
    )
    ok = SendResult(ok=True, message="sent")
    bodies: list[tuple[str, bool]] = []

    def fake_send(_ch, text, *, anyway=False, **_k):
        # strip signed/mara prefix for assertion friendliness
        bodies.append((text, anyway))
        if anyway:
            return ok
        if len(bodies) == 1:
            return crossed
        return ok

    async with app.run_test() as pilot:
        import porch3.send as send_mod

        with patch.object(send_mod, "send_as_owner", side_effect=fake_send):
            composer = app.query_one("#composer", Composer)
            await pilot.click("#composer")
            for ch in "original":
                await pilot.press(ch)
            await pilot.press("enter")
            await pilot.pause()
            bounce = app.query_one("#bounce", BounceBanner)
            assert bounce.active
            # Edit while banner active
            composer.set_draft("edited-final")
            await pilot.press("enter")
            await pilot.pause()
            assert not bounce.active
            # Second call must be NORMAL send of edited text, not --anyway of original
            assert len(bodies) >= 2
            last_body, last_anyway = bodies[-1]
            assert "edited-final" in last_body
            assert "original" not in last_body
            assert last_anyway is False


async def test_delivered_output_failure_clears_draft_no_retry(channel_root: Path):
    """Finding 4a: committed failure clears draft; Enter-again must not resend."""
    app = _make_app(channel_root)
    committed = SendResult(
        ok=False,
        error_code="delivered_output_failure",
        message="stdout broke",
    )
    calls = {"n": 0}

    def fake_send(*_a, **_k):
        calls["n"] += 1
        return committed

    async with app.run_test() as pilot:
        import porch3.send as send_mod

        with patch.object(send_mod, "send_as_owner", side_effect=fake_send):
            composer = app.query_one("#composer", Composer)
            await pilot.click("#composer")
            for ch in "payload":
                await pilot.press(ch)
            await pilot.press("enter")
            await pilot.pause()
            assert calls["n"] == 1
            assert composer.text.strip() == ""
            assert "committed" in app.status.lower() or "OUTPUT FAILED" in app.status
            # Enter again with empty composer must not send
            await pilot.press("enter")
            await pilot.pause()
            assert calls["n"] == 1


async def test_vote_img_preserve_draft_on_failure(channel_root: Path, tmp_path: Path):
    """Finding 4b: /vote and /img clear composer only on success."""
    app = _make_app(channel_root)
    crossed = SendResult(
        ok=False,
        error_code="crossed_send",
        message="crossed",
        missed=[
            {
                "id": "m1",
                "from": "juniper",
                "sent": "2025-01-06 12:30:00 -0400",
                "body": "x",
                "mentions": [],
            }
        ],
    )

    async with app.run_test() as pilot:
        import porch3.send as send_mod

        with patch.object(send_mod, "send_as_owner", return_value=crossed):
            composer = app.query_one("#composer", Composer)
            await pilot.click("#composer")
            composer.set_draft("/vote p0805-020830 b")
            await pilot.press("enter")
            await pilot.pause()
            assert "/vote p0805-020830 b" in composer.text
            assert app.query_one("#bounce", BounceBanner).active
            await pilot.press("escape")
            await pilot.pause()

            png = _tiny_png(tmp_path / "ok.png")
            composer.set_draft(f"/img {png}")
            await pilot.press("enter")
            await pilot.pause()
            assert f"/img {png}" in composer.text


async def test_sidecar_cleanup_on_crossed_retain_on_committed(
    channel_root: Path, tmp_path: Path
):
    """Finding 4c: clean attempt sidecars on crossed; retain on committed fail."""
    cfg = make_porch_config(tmp_path)
    signer = Signer(cfg)
    # Pretend signing is on so sign_and_send path is used
    signer.env = {"SSH_AUTH_SOCK": "/dev/null", "SSH_AGENT_PID": "1"}

    payload = tmp_path / "ts.txt"
    sig = tmp_path / "ts.txt.sig"
    payload.write_text("ts\nbody\n")
    sig.write_text("SIG")
    signer.last_payload = payload
    signer.last_sig = sig

    crossed = SendResult(ok=False, error_code="crossed_send", message="crossed", missed=[])
    committed = SendResult(
        ok=False, error_code="delivered_output_failure", message="out"
    )

    app = _make_app(channel_root, signer=signer)

    async with app.run_test() as pilot:
        # Drive crossed via _do_send with mocked sign_and_send
        def fake_sign_crossed(ch, text, *, anyway=False):
            signer.last_payload = payload
            signer.last_sig = sig
            return crossed

        with patch.object(signer, "sign_and_send", side_effect=fake_sign_crossed):
            composer = app.query_one("#composer", Composer)
            composer.set_draft("hello")
            app._do_send("hello")
            await pilot.pause()
            assert not payload.exists()
            assert not sig.exists()

        # Recreate for committed path
        payload.write_text("ts\nbody\n")
        sig.write_text("SIG")
        signer.last_payload = payload
        signer.last_sig = sig

        def fake_sign_committed(ch, text, *, anyway=False):
            signer.last_payload = payload
            signer.last_sig = sig
            return committed

        with patch.object(signer, "sign_and_send", side_effect=fake_sign_committed):
            composer.set_draft("hello2")
            app._do_send("hello2")
            await pilot.pause()
            assert payload.exists()
            assert sig.exists()
            assert composer.text.strip() == ""


async def test_mention_highlight_in_message_list(channel_root: Path):
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        messages = app.query_one("#messages", MessageList)
        # Message 1 mentions @mara — block should have owner-mention class
        trey_blocks = messages.query("MessageBlock.owner-mention")
        assert len(trey_blocks) >= 1


async def test_image_path_renders_block(channel_root: Path, tmp_path: Path):
    png = _tiny_png(tmp_path / "pic.png")
    spooled = spool_image(png, spool_dir=tmp_path / "spool")
    store = channel_root / "commons" / "messages"
    mid = "20250106-129999-000000-img001"
    meta = {
        "id": mid,
        "from": "mara",
        "sent": "2025-01-06 12:59:00 -0400",
    }
    # Spool auto-render requires an unspoofable own signal (cs-c0d): a signed
    # message the verify cache positively confirmed. Seed both.
    (store / f"{mid}.msg").write_text(
        json.dumps(meta) + "\n---\n" + f"🦊🔏 look {spooled} [signed:20250106T125900Z]\n"
    )
    verify_mod.VERIFY_CACHE[mid] = " 🔏✓"

    # Point IMAGE_SPOOL_DIR at our spool for auto-render
    import porch3.images as images_mod
    import porch3.widgets.message_block as mb_mod

    with patch.object(images_mod, "IMAGE_SPOOL_DIR", tmp_path / "spool"), patch.object(
        mb_mod, "is_spool_path",
        lambda p: images_mod.is_spool_path(p, tmp_path / "spool"),
    ):
        app = _make_app(channel_root)
        async with app.run_test() as pilot:
            await pilot.pause()
            messages = app.query_one("#messages", MessageList)
            imgs = list(messages.query(".inline-image")) + list(
                messages.query(".inline-image-fallback")
            )
            assert len(imgs) >= 1


async def test_markup_hostile_strings_do_not_crash(channel_root: Path):
    """Finding 6: [/red] and [link=…] in description/body must not MarkupError."""
    (channel_root / "commons" / "channel.json").write_text(
        json.dumps(
            {
                "name": "commons",
                "description": "norms [/red] and [link=http://x]y[/link]",
            }
        )
    )
    store = channel_root / "commons" / "messages"
    mid = "20250106-140000-000000-markup"
    meta = {
        "id": mid,
        "from": "juniper[/red]",
        "sent": "2025-01-06 14:00:00 -0400",
        "display_name": "evil[/red]",
    }
    body = "hello [/red] and [link=http://evil]click[/link]"
    (store / f"{mid}.msg").write_text(json.dumps(meta) + "\n---\n" + body + "\n")

    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        messages = app.query_one("#messages", MessageList)
        # Layout must complete; hostile markup appears as literal text
        plain = " ".join(
            b._header_text().plain for b in messages.query(MessageBlock)
        )
        assert "[/red]" in plain or "evil" in plain
        # Open browser — description must not crash
        await pilot.press("left")
        await pilot.pause()
        browser = app.query_one("#browser", ChannelBrowser)
        assert browser.channels


async def test_terminal_controls_sanitized_in_render(channel_root: Path):
    """BLOCKER 10: CSI/OSC/bidi must not survive rendered Text segments."""
    from porch3.sanitize import contains_raw_controls

    osc52 = "\x1b]52;c;QUJDRA==\x07"
    (channel_root / "commons" / "channel.json").write_text(
        json.dumps(
            {
                "name": "commons",
                "description": f"norms \x1b[2J {osc52} \u202e [/red] [link=http://x]y[/link]",
            }
        )
    )
    store = channel_root / "commons" / "messages"
    mid = "20250106-150000-000000-ctrl01"
    meta = {
        "id": mid,
        "from": f"juniper\x1b[2J",
        "sent": "2025-01-06 15:00:00 -0400",
        "display_name": f"evil\u202ename",
        "re": "20250106-120000-000000-aaaaa0",
    }
    body = (
        f"body \x1b[2J {osc52} \u202e override [/red] "
        f"[link=http://evil]click[/link] @juniper"
    )
    (store / f"{mid}.msg").write_text(json.dumps(meta) + "\n---\n" + body + "\n")

    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        messages = app.query_one("#messages", MessageList)
        segments: list[str] = []
        for block in messages.query(MessageBlock):
            segments.append(block._header_text().plain)
            body_w = block.query(".msg-body")
            for w in body_w:
                r = getattr(w, "renderable", None)
                if hasattr(r, "plain"):
                    segments.append(r.plain)
                else:
                    segments.append(str(w.render()))
            for w in block.query(".msg-reply"):
                r = getattr(w, "renderable", None)
                if hasattr(r, "plain"):
                    segments.append(r.plain)
        status = app.query_one("#status-bar")
        r = getattr(status, "renderable", None)
        if hasattr(r, "plain"):
            segments.append(r.plain)

        joined = "\n".join(segments)
        assert not contains_raw_controls(joined), repr(joined)
        assert "\x1b" not in joined
        assert "\x07" not in joined
        assert "\u202e" not in joined
        # markup still literal (finding 6)
        assert "[/red]" in joined or "[link=" in joined

        await pilot.press("left")
        await pilot.pause()
        browser = app.query_one("#browser", ChannelBrowser)
        for w in browser.query(".chan-desc, .chan-preview"):
            r = getattr(w, "renderable", None)
            plain = r.plain if hasattr(r, "plain") else str(w.render())
            assert not contains_raw_controls(plain), repr(plain)
            assert "\x1b" not in plain
        assert app.mode == "channels"


async def test_presence_exposes_per_member_liveness(channel_root: Path):
    """Finding 9: browser exposes per-room member liveness, not any() alone."""
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        with patch(
            "porch3.app.fetch_presence",
            return_value={"mara": True, "juniper": False},
        ):
            await pilot.press("left")
            await pilot.pause()
            browser = app.query_one("#browser", ChannelBrowser)
            live = browser.member_liveness("commons")
            assert live.get("mara") is True
            assert live.get("juniper") is False
            # Member row rendered
            assert list(browser.query(".chan-members"))


async def test_vote_bounce_unchanged_resends_wire_with_anyway(channel_root: Path):
    """Round-3 finding 1: unchanged slash draft after bounce must resend the
    expanded WIRE body with anyway=True — never the raw slash command."""
    app = _make_app(channel_root)
    crossed = SendResult(
        ok=False,
        error_code="crossed_send",
        message="crossed",
        missed=[
            {
                "id": "m1",
                "from": "juniper",
                "sent": "2025-01-06 12:30:00 -0400",
                "body": "landed first",
                "mentions": [],
            }
        ],
    )
    ok = SendResult(ok=True, message="sent")
    calls: list[tuple[str, bool]] = []

    def fake_send(_ch, text, *, anyway=False, **_k):
        calls.append((text, anyway))
        return ok if anyway else crossed

    async with app.run_test() as pilot:
        import porch3.send as send_mod

        with patch.object(send_mod, "send_as_owner", side_effect=fake_send):
            composer = app.query_one("#composer", Composer)
            await pilot.click("#composer")
            for ch in "/vote p1 b":
                await pilot.press(ch if ch != " " else "space")
            await pilot.press("enter")
            await pilot.pause()
            assert app.query_one("#bounce", BounceBanner).active
            assert calls == [("🗳️ p1: b", False)]
            # Draft (display form) preserved, unchanged → Enter resends wire
            assert composer.text.strip() == "/vote p1 b"
            await pilot.press("enter")
            await pilot.pause()
            assert calls == [("🗳️ p1: b", False), ("🗳️ p1: b", True)]


async def test_reveal_is_per_message_and_off_thread(channel_root: Path, tmp_path: Path):
    """Round-3 findings 4+5: compose opens NO foreign file; ctrl+r works with
    the composer focused, inserts no text, validates in a worker, and reveals
    only the newest deferred message per press."""
    img_old = _tiny_png(tmp_path / "old.png")
    img_new = _tiny_png(tmp_path / "new.png")
    store = channel_root / "commons" / "messages"
    for i, img in ((7, img_old), (8, img_new)):
        mid = f"20250106-12000{i}-000000-aaaaa{i}"
        meta = {
            "id": mid,
            "from": "juniper",
            "sent": f"2025-01-06 12:0{i}:00 -0400",
            "mentions": [],
        }
        (store / f"{mid}.msg").write_text(
            json.dumps(meta) + "\n---\n" + f"see {img}\n"
        )

    import porch3.widgets.message_block as mb_mod

    real_prepare = mb_mod.prepare_thumbnail
    validated_paths: list[str] = []

    def counting_validate(path, **kw):
        validated_paths.append(str(path))
        return real_prepare(path, **kw)

    app = _make_app(channel_root)
    with patch.object(mb_mod, "prepare_thumbnail", side_effect=counting_validate):
        async with app.run_test() as pilot:
            await pilot.pause()
            # Compose must not have opened/validated any foreign file
            assert validated_paths == []
            messages = app.query_one("#messages", MessageList)
            assert len(list(messages.query(".img-deferred"))) == 2

            composer = app.query_one("#composer", Composer)
            composer.focus()
            await pilot.pause()
            await pilot.press("ctrl+r")
            for _ in range(20):
                await pilot.pause(0.05)
                if validated_paths:
                    break
            # No text leaked into the focused composer
            assert composer.text == ""
            # Only the NEWEST deferred message validated — one file, once
            assert validated_paths == [str(img_new)]
            # The older message's deferred label remains
            assert len(list(messages.query(".img-deferred"))) >= 1


async def test_ui_thread_pixeldata_only_bounded_thumbnails(
    channel_root: Path, tmp_path: Path
):
    """Final blocker: the UI thread must never hand textual-image a path or a
    full-size image — only the worker-prepared bounded thumbnail."""
    import threading

    from PIL import Image as PILImage

    pixeldata_mod = pytest.importorskip("textual_image._pixeldata")

    # A large-but-allowed source image (bigger than the thumbnail budget)
    big = tmp_path / "spool" / "big.png"
    big.parent.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", (1000, 800), (0, 128, 255)).save(big)

    store = channel_root / "commons" / "messages"
    mid = "20250106-120009-000000-aaaaa9"
    meta = {
        "id": mid,
        "from": "juniper",
        "sent": "2025-01-06 12:09:00 -0400",
        "mentions": [],
    }
    (store / f"{mid}.msg").write_text(json.dumps(meta) + "\n---\n" + f"see {big}\n")

    import porch3.images as images_mod
    import porch3.widgets.message_block as mb_mod

    ui_inits: list[tuple[int, object]] = []
    real_init = pixeldata_mod.PixelData.__init__

    def spy_init(self, source, *a, **k):
        ui_inits.append((threading.get_ident(), source))
        return real_init(self, source, *a, **k)

    app = _make_app(channel_root)
    with patch.object(images_mod, "IMAGE_SPOOL_DIR", tmp_path / "spool"), patch.object(
        mb_mod, "is_spool_path",
        lambda p: images_mod.is_spool_path(p, tmp_path / "spool"),
    ), patch.object(pixeldata_mod.PixelData, "__init__", spy_init):
        async with app.run_test() as pilot:
            ui_thread = threading.get_ident()
            # Wait for the spool auto-prepare worker to mount
            for _ in range(40):
                await pilot.pause(0.05)
                messages = app.query_one("#messages", MessageList)
                if list(messages.query(".inline-image")) or list(
                    messages.query(".inline-image-fallback")
                ):
                    break
            ui_thread_inputs = [
                src for tid, src in ui_inits if tid == ui_thread
            ]
            for src in ui_thread_inputs:
                # Never a path/str; always an already-bounded PIL image
                assert not isinstance(src, (str, Path)), src
                assert isinstance(src, PILImage.Image), type(src)
                w, h = src.size
                assert w <= images_mod.THUMBNAIL_MAX_SIZE[0]
                assert h <= images_mod.THUMBNAIL_MAX_SIZE[1]


async def test_scroll_up_repaints_viewport(channel_root: Path):
    """Regression: MessageList.watch_scroll_y must chain to Widget's watcher
    (scrollbar position + repaint) — without super(), scrolling changed
    scroll_y invisibly and the viewport never moved."""
    _seed_channel(channel_root, "busy", n=40)
    app = _make_app(channel_root, channel="busy")
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.pause(0.2)
        messages = app.query_one("#messages", MessageList)
        assert messages.max_scroll_y > 0, "seed must overflow the viewport"
        bottom = messages.scroll_y
        await pilot.press("pageup")
        await pilot.pause()
        assert messages.scroll_y < bottom
        # The base watcher must have propagated the position to the scrollbar
        assert messages.vertical_scrollbar.position == messages.scroll_y
        # Scrolling up released the bottom anchor (Textual-native hold)
        assert messages._anchor_released is True


async def test_rendered_messages_catch_cursor_up(channel_root: Path):
    """Rendered == read: opening a channel and rendering fresh polled messages
    both move mara's cursor (gated off in skip_join/test mode)."""
    calls: list[str] = []
    app = _make_app(channel_root)
    with patch("porch3.app.catch_up_as_owner", lambda ch, config=None: calls.append(ch) or True):
        async with app.run_test() as pilot:
            await pilot.pause(0.2)
            # skip_join gates real post calls off entirely
            assert calls == []
            app.skip_join = False
            # Fresh message lands → rendered → cursor catches up
            _seed_channel(channel_root, "commons", n=5)
            app._poll_messages()
            await pilot.pause()
            assert calls == ["commons"]
            # Opening a channel renders everything → catches up too
            app._open_channel("workbench")
            await pilot.pause()
            assert calls[-1] == "workbench"


def _drop_msg(root: Path, channel: str, mid: str, body: str, sender: str = "juniper") -> None:
    store = root / channel / "messages"
    meta = {
        "id": mid,
        "from": sender,
        "sent": f"2025-01-08 22:{mid[-2:]}:00 -0400",
        "mentions": [],
    }
    (store / f"{mid}.msg").write_text(json.dumps(meta) + "\n---\n" + body + "\n")


async def test_pagedown_at_bottom_keeps_follow(channel_root: Path):
    """A PageDown at the bottom is a no-op scroll, but it must NOT leave the
    anchor released: scroll_page_down calls _scroll_to(release_anchor=True)
    unconditionally, and with scroll_y unchanged the anchor would stay
    released forever, parking every later append off-screen. The page action
    must re-arm the anchor (_check_anchor) when the viewport is at the end."""
    _seed_channel(channel_root, "busy", n=30)
    app = _make_app(channel_root, channel="busy")
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.pause(0.2)
        messages = app.query_one("#messages", MessageList)
        assert messages.max_scroll_y > 0
        assert messages.is_vertical_scroll_end
        app.action_page_down()  # no-op at the bottom — must not release follow
        await pilot.pause()
        assert messages.is_vertical_scroll_end
        tall = "opening line. " + ("wrap word " * 300)
        for i, body in enumerate([tall, "short follow-up one", "short follow-up two"]):
            _drop_msg(channel_root, "busy", f"20250108-2210{i:02d}-000000-page{i:02d}", body)
            app._poll_messages()
            await pilot.pause(0.3)
            assert messages.is_vertical_scroll_end, f"append {i} lost the bottom after PageDown"


async def test_bottom_follow_survives_tall_append(channel_root: Path):
    """Regression: a tall message mounting
    mid-layout latched the old _hold_viewport heuristic; the viewport parked
    between messages and EVERY later append rendered off-screen until
    restart. Anchored follow must survive a real scroll-up / scroll-back
    cycle (anchor re-armed by _check_anchor) and land every append at the
    bottom."""
    _seed_channel(channel_root, "busy", n=30)
    app = _make_app(channel_root, channel="busy")
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.pause(0.2)
        messages = app.query_one("#messages", MessageList)
        assert messages.max_scroll_y > 0
        # Real user scroll-up releases the anchor…
        await pilot.press("pageup")
        await pilot.pause()
        assert messages._anchor_released
        # …and scrolling back to the bottom re-arms it (_check_anchor).
        messages.scroll_end(animate=False)
        await pilot.pause()
        assert not messages._anchor_released
        assert messages.is_vertical_scroll_end
        tall = "opening line. " + ("wrap word " * 300)
        for i, body in enumerate([tall, "short follow-up one", "short follow-up two"]):
            _drop_msg(channel_root, "busy", f"20250108-2201{i:02d}-000000-tall{i:02d}", body)
            app._poll_messages()
            await pilot.pause(0.3)
            assert messages.is_vertical_scroll_end, f"append {i} lost the bottom"
            assert not messages._anchor_released, f"append {i} released the anchor"


async def test_scroll_up_holds_appends_then_send_snaps_bottom(channel_root: Path):
    """Scrolled-up viewport must hold through appends (anchor released), and a
    successful send must snap back to the bottom and re-arm follow."""
    _seed_channel(channel_root, "busy", n=30)
    app = _make_app(channel_root, channel="busy")
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.pause(0.2)
        messages = app.query_one("#messages", MessageList)
        await pilot.press("pageup")
        await pilot.pause()
        held = messages.scroll_y
        assert messages._anchor_released
        _drop_msg(channel_root, "busy", "20250108-220140-000000-held01", "arrives while held")
        app._poll_messages()
        await pilot.pause(0.2)
        assert messages.scroll_y == held, "append moved a held viewport"

        import porch3.send as send_mod

        def fake_send(channel, text, anyway=False, raw=False, config=None):
            mid = "20250108-220150-000000-mine01"
            _drop_msg(
                channel_root,
                "busy",
                mid,
                f"owner-prefix {text}",
                sender="mara",
            )
            return SendResult(
                ok=True,
                message="sent",
                raw={"message": {"id": mid}},
            )

        with patch.object(send_mod, "send_as_owner", side_effect=fake_send):
            await pilot.click("#composer")
            await pilot.press("h", "i")
            await pilot.press("enter")
            await pilot.pause(0.3)
        assert messages.is_vertical_scroll_end, "send did not snap to bottom"
        assert not messages._anchor_released, "send did not re-arm follow"


async def test_rapid_channel_rebuilds_never_duplicate_blocks(channel_root: Path):
    """Un-awaited remove_children + mount left old/new block ordering
    undefined; rapid channel switches must end with exactly one block per
    message of the final channel."""
    _seed_channel(channel_root, "busy", n=8)
    app = _make_app(channel_root)
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.pause(0.2)
        app._open_channel("busy")
        app._open_channel("commons")
        app._open_channel("busy")
        await pilot.pause(0.4)
        messages = app.query_one("#messages", MessageList)
        blocks = list(messages.query(MessageBlock))
        assert len(blocks) == 8, f"expected 8 blocks, found {len(blocks)}"
        ids = [b.msg["id"] for b in blocks]
        assert len(ids) == len(set(ids)), "duplicate message blocks mounted"


async def test_paste_image_done_inserts_path_and_falls_back(
    channel_root: Path, tmp_path: Path
):
    """_paste_image_done: spool path lands in the composer; (None, None)
    falls back to the TextArea's own text paste; (None, reason) shows the
    reason and must NOT splice text over the selection."""
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause(0.2)
        composer = app.query_one("#composer", Composer)
        png = _tiny_png(tmp_path / "clip.png")
        app._paste_image_done(png)
        await pilot.pause()
        assert str(png) in composer.text
        assert app.status == "image attached — Enter to send"
        app._paste_image_done(None, None)
        await pilot.pause()
        assert app.status == "no image on clipboard"
        # Rejected image: reason on the status line, no action_paste fallback.
        pastes: list[object] = []
        composer.action_paste = lambda: pastes.append(1)  # type: ignore[method-assign]
        app._paste_image_done(None, "clipboard image too large")
        await pilot.pause()
        assert pastes == [], "rejected image must not fall through to text paste"
        assert app.status == "clipboard image too large"


async def test_rapid_appends_keep_block_children_intact(channel_root: Path):
    """Regression: two blocks mounting
    close together interleaved on screen — header A / header B / body A, with
    body B never rendered. Every block must own its header and its body, in
    order, and the list must hold the blocks in message order. The single
    awaited batch mount must not fragment into per-block mounts."""
    app = _make_app(channel_root)
    async with app.run_test(size=(80, 24)) as pilot:
        await pilot.pause(0.2)
        messages = app.query_one("#messages", MessageList)
        first = "20250108-220510-000000-rapid1"
        second = "20250108-220520-000000-rapid2"

        # Instrument MessageList.mount: each append batch must produce
        # exactly ONE awaited mount call with that batch's block(s).
        mount_sizes: list[int] = []
        orig_mount = MessageList.mount

        async def counting_mount(self, *children, **kwargs) -> None:
            mount_sizes.append(len(children))
            await orig_mount(self, *children, **kwargs)

        with patch.object(MessageList, "mount", counting_mount):
            _drop_msg(channel_root, "commons", first, "first rapid body")
            app._poll_messages()
            # Second poll fires before the first mount settles — the live repro
            _drop_msg(channel_root, "commons", second, "second rapid body")
            app._poll_messages()
            await pilot.pause(0.4)
        assert mount_sizes == [1, 1], (
            f"expected one mount per append batch, got {mount_sizes}"
        )
        for mid, want in ((first, "first rapid body"), (second, "second rapid body")):
            block = messages._blocks_by_id[mid]
            assert block.parent is messages, f"{mid} block not mounted in list"
            bodies = list(block.query(".msg-body"))
            assert len(bodies) == 1, f"{mid} lost its body"
            rendered = bodies[0].render()
            plain = getattr(rendered, "plain", str(rendered))
            assert want in plain
            kids = list(block.children)
            header_i = next(i for i, w in enumerate(kids) if "msg-header" in w.classes)
            body_i = next(i for i, w in enumerate(kids) if "msg-body" in w.classes)
            assert header_i < body_i, f"{mid} header/body out of order"
        mounted = [w for w in messages._nodes if isinstance(w, MessageBlock)]
        ids = [b.msg["id"] for b in mounted]
        assert ids.index(first) < ids.index(second), "blocks out of message order"


async def test_dr_observe_ratifies_treys_signed_accept(
    channel_root: Path, tmp_path: Path, monkeypatch
):
    """Mara's accept message, observed via the poll path, ratifies the DR;
    a non-mara sender saying the same words does not."""
    from porch3 import drstore

    cfg = make_porch_config(channel_root)
    log = cfg.dr_log_path
    # Authority now binds the signed body to the exact (dr, verb) via
    # authentic_action; tests cannot mint real ssh signatures, so stub the
    # authenticity layer to vouch for Mara's exact accept id only.
    monkeypatch.setattr(
        drstore,
        "authentic_action",
        lambda mid, mail_root=None, wire=None, **kw: (
            ("dr-1", "accepted", None) if mid == "20250108-2232" else None
        ),
    )
    drstore.propose(
        title="t", project="p", channel="commons",
        anchor_message_id="m-anchor", path=log,
    )
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(20):
            if app.dr_records:
                break
            await pilot.pause(0.05)
        assert app.dr_records["dr-1"]["state"] == "needs_operator_decision"
        wire = "🦊🔏 ⚖️ DR dr-1 accepted [signed:20250109T050000Z]"
        # An imposter's accept must not ratify.
        _drop_msg(channel_root, "commons", "20250108-2230", wire, sender="mallory")
        # An action phrase EMBEDDED in Mara prose must not parse (injection
        # blocker: authority never derives from substring matches).
        _drop_msg(
            channel_root, "commons", "20250108-2231",
            "🦊🔏 quoting \"⚖️ DR dr-1 accepted\" for context [signed:x]",
            sender="mara",
        )
        app._poll_messages()
        await pilot.pause()
        records = drstore.project(
            drstore.replay(log), verifier=lambda m: True
        )
        assert records["dr-1"]["state"] == "needs_operator_decision"
        # Mara's exact signed action body ratifies.
        _drop_msg(channel_root, "commons", "20250108-2232", wire, sender="mara")
        app._poll_messages()
        await pilot.pause()
        for _ in range(20):
            if app.dr_records.get("dr-1", {}).get("state") == "ratified":
                break
            await pilot.pause(0.05)
        assert app.dr_records["dr-1"]["state"] == "ratified"
        assert app.dr_records["dr-1"]["actor_message_id"] == "20250108-2232"


def test_unsigned_trey_body_denied_spool_privilege():
    """cs-c0d: from=='mara' is a spoofable heuristic. An unsigned message
    claiming from mara gets NO spool-render privilege unless it is either in
    this session's own-ids or a positively-verified signature."""
    msg = {
        "id": "20250110-000000-000000-foreign1",
        "from": "mara",
        "sent": "2025-01-10 00:00:00 -0400",
        "body": "look /home/x/.cache/porch/spool/deadbeef.png",
    }
    # Unsigned, not in own_ids → not own.
    block = MessageBlock(msg, color="#fff", own_ids=set(), owner_room="mara")
    assert block._own is False
    # Emitted by this session → own.
    block_own = MessageBlock(msg, color="#fff", own_ids={msg["id"]}, owner_room="mara")
    assert block_own._own is True
    # Verified signature → own, even across restarts (not in own_ids).
    signed = dict(msg, body="🦊🔏 hi [signed:20250110T000000Z]")
    verify_mod.VERIFY_CACHE[signed["id"]] = " 🔏✓"
    try:
        assert MessageBlock(signed, color="#fff", own_ids=set(), owner_room="mara")._own is True
        # A signed-but-UNVERIFIED message is still not own.
        verify_mod.VERIFY_CACHE[signed["id"]] = " 🔏✗UNVERIFIED"
        assert MessageBlock(signed, color="#fff", own_ids=set(), owner_room="mara")._own is False
    finally:
        verify_mod.VERIFY_CACHE.pop(signed["id"], None)


def test_message_block_uses_the_configured_owner_accent():
    """Item 20: a custom owner_accent must color the owner's own sender
    (not the theme palette color it was constructed with) and must reach
    highlight_mentions for @owner_room spans in the body."""
    accent = "#12AB34"
    owner_msg = {
        "id": "20250110-000000-000000-ownerone",
        "from": "mara",
        "sent": "2025-01-10 00:00:00 -0400",
        "body": "hi",
    }
    block = MessageBlock(
        owner_msg, color="#00ff00", owner_room="mara", owner_accent=accent,
    )
    assert block.color == accent
    assert block.styles.border_left[1].hex.lower() == accent.lower()

    other_msg = dict(owner_msg, id="20250110-000000-000000-otherone", **{"from": "juniper"})
    other_block = MessageBlock(
        other_msg, color="#00ff00", owner_room="mara", owner_accent=accent,
    )
    # A non-owner sender keeps the theme color untouched by the accent.
    assert other_block.color == "#00ff00"


def test_textual_private_scroll_api_tripwire():
    """cs-c0d: action_page_up/down drive Textual's private _scroll_to and
    _check_anchor for immediate (non-deferred) scroll + anchor re-arm. If
    Textual bumps off 8.2.8, re-audit those semantics before trusting them."""
    import textual

    from porch3.widgets.message_list import MessageList

    assert textual.__version__ == "8.2.8", (
        f"Textual is {textual.__version__}, not the audited 8.2.8. "
        "action_page_up/down rely on the private _scroll_to(y=, animate=) and "
        "_check_anchor() semantics — re-audit src/porch3/app.py against the new "
        "Textual source and update this pin before shipping."
    )
    assert callable(getattr(MessageList, "_scroll_to", None))
    assert callable(getattr(MessageList, "_check_anchor", None))


async def test_unknown_prefix_command_does_not_broadcast_as_trey(channel_root: Path):
    """Review MAJOR: `/votex choice` matched the /vote prefix and sent
    `🗳️ x: choice` as Mara. Every slash command dispatches by EXACT first
    token now; unknown ones are refused with the draft kept."""
    app = _make_app(channel_root)
    async with app.run_test() as pilot:
        await pilot.pause()
        sent: list = []
        app._do_send = lambda *a, **k: sent.append((a, k))  # type: ignore
        for probe in ("/votex choice", "/copyx", "/imgx x", "/seenx", "/frobnicate"):
            app._submit_text(probe)
            await pilot.pause()
        # Nothing was broadcast; each was refused.
        assert sent == [], f"unknown command broadcast: {sent}"
        assert "unknown command" in app.status
        # Real commands still dispatch: exact /vote reaches _do_send.
        app._submit_text("/vote poll1 yes")
        await pilot.pause()
        assert len(sent) == 1, "exact /vote should still send"


def test_message_block_mention_spans_use_registered_rooms():
    """Item 7: rooms vocabulary must reach highlight_mentions (not rooms=None)."""
    rooms = frozenset({"mara", "juniper"})
    accent = "#12AB34"
    msg = {
        "id": "20250110-000000-000000-mention1",
        "from": "juniper",
        "sent": "2025-01-10 00:00:00 -0400",
        "body": "hey @mara and @juniper please",
        "mentions": [],
    }
    block = MessageBlock(
        msg,
        color="#00ff00",
        owner_room="mara",
        owner_accent=accent,
        rooms=rooms,
    )
    assert "owner-mention" in (block.classes or [])
    # Compose body text the same way MessageBlock does.
    from porch3.mentions import highlight_mentions
    from porch3.images import display_body
    from porch3.store import clean_body

    text = highlight_mentions(
        display_body(clean_body(msg["body"]), own=False),
        owner_room="mara",
        owner_accent=accent,
        rooms=rooms,
    )
    plain = text.plain
    spans = list(text.spans)
    trey_span = next(s for s in spans if "@mara" in plain[s.start:s.end])
    pact_span = next(s for s in spans if "@juniper" in plain[s.start:s.end])
    assert str(trey_span.style.color.name) == accent.lower()
    assert str(trey_span.style) != str(pact_span.style)


def test_bounce_banner_passes_owner_accent(channel_root: Path):
    """Item 5: BounceBanner must not fall back to gold for owner messages."""
    accent = "#AABBCC"
    banner = BounceBanner(
        owner_room="mara",
        owner_accent=accent,
        rooms=frozenset({"mara"}),
    )
    owner_msg = {
        "id": "20250110-000000-000000-bounce1",
        "from": "mara",
        "sent": "2025-01-10 00:00:00 -0400",
        "body": "missed",
    }
    # Drive show_missed without a full Textual mount: construct as MessageBlock does.
    block = MessageBlock(
        owner_msg,
        color="#00ff00",
        owner_room=banner.owner_room,
        bounce=True,
        owner_accent=banner.owner_accent,
        rooms=banner.rooms,
    )
    assert block.color == accent
    assert block.owner_accent == accent
