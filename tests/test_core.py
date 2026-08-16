"""Ported + extended unit tests for porch3 core (store, verify, commands)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from porch3 import commands, store, verify
from porch3.constants import IMAGE_MAX_BYTES
from porch3.images import (
    ImageValidationError,
    find_image_paths,
    spool_image,
    validate_image,
)
from porch3.mentions import clear_rooms_cache, highlight_mentions, mention_pattern
from porch3.send import SendResult, send_as_owner
from helpers import make_porch_config
from porch3.theme import SenderTheme


def write_message(root, channel, message_id, sender, sent, body, event=None, **extra):
    store_dir = root / channel / "messages"
    store_dir.mkdir(parents=True, exist_ok=True)
    meta = {"id": message_id, "from": sender, "sent": sent, **extra}
    if event:
        meta["event"] = event
    (store_dir / f"{message_id}.msg").write_text(
        json.dumps(meta) + "\n---\n" + body + "\n"
    )


class ChannelBrowserTest(unittest.TestCase):
    def test_lists_channels_with_latest_activity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_message(
                root, "workbench", "001", "juniper",
                "2025-01-04 21:18:54 -0400", "first",
            )
            write_message(
                root, "workbench", "002", "finch",
                "2025-01-04 21:19:54 -0400", "newest\nmessage",
            )
            write_message(
                root, "commons", "001", "mara",
                "2025-01-04 21:17:00 -0400", "🦊 hello",
            )
            write_message(
                root, "workbench", "003", "mara",
                "2025-01-04 21:20:54 -0400", "=== mara joined ===",
                event="join",
            )
            self.assertEqual(store.discover_channels(root), ["commons", "workbench"])
            self.assertEqual(
                store.channel_preview("workbench", root),
                ("21:19", "finch", "newest message"),
            )

    def test_new_channels_are_auto_joined_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "commons" / "messages").mkdir(parents=True)
            (root / "workbench" / "messages").mkdir(parents=True)
            known = {"commons"}
            cfg = make_porch_config(root)
            with patch.object(store, "join_channel", return_value=True) as join:
                channels, failures = store.sync_channels(known, root, config=cfg)
                self.assertEqual(channels, ["commons", "workbench"])
                self.assertEqual(failures, [])
                join.assert_called_once_with("workbench", config=cfg)
                store.sync_channels(known, root, config=cfg)
                join.assert_called_once()

    def test_copy_out(self):
        msgs = [
            {"id": "a", "from": "juniper", "sent": "2025-01-05 00:01:00 -0400", "body": "alpha"},
            {"id": "b", "from": "finch", "sent": "2025-01-05 00:02:00 -0400", "body": "beta"},
        ]
        with patch.object(commands.subprocess, "run") as run:
            self.assertIn("finch", commands.copy_out(msgs))
            run.assert_called_once()
            self.assertEqual(run.call_args.kwargs["input"], b"beta")
            self.assertIn("juniper", commands.copy_out(msgs, "2"))
        self.assertEqual(commands.copy_out([], ""), "nothing to copy")
        self.assertIn("only 2 messages", commands.copy_out(msgs, "9"))
        self.assertIn("takes a number", commands.copy_out(msgs, "x"))

    def test_save_transcript(self):
        msgs = [{"id": "a", "from": "juniper", "sent": "s", "body": "alpha"}]
        with patch.object(commands.subprocess, "Popen") as popen:
            status = commands.save_transcript("commons", msgs)
        self.assertIn("saved 1 msgs", status)
        path = Path(popen.call_args.args[0][1])
        self.assertIn("alpha", path.read_text())
        path.unlink()
        self.assertEqual(commands.save_transcript("commons", []), "nothing to save")

    def test_vote_text(self):
        self.assertEqual(
            commands.vote_text("p0805-020830 b"),
            ("🗳️ p0805-020830: b", None),
        )
        self.assertEqual(commands.vote_text("")[0], None)
        self.assertEqual(commands.vote_text("only-one")[0], None)
        self.assertEqual(commands.vote_text("a b c")[0], None)

    def test_verify_cache_round_trip(self):
        from porch3.verify import clear_trust_context

        verify.VERIFY_CACHE.clear()
        clear_trust_context()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            verify.VERIFY_CACHE["msg-a"] = " 🔏✓"
            verify.VERIFY_CACHE["msg-b"] = " 🔏✗UNVERIFIED"
            verify.save_verify_cache(path)
            self.assertTrue(path.is_file())
            verify.VERIFY_CACHE.clear()
            verify.load_verify_cache(path)
            self.assertEqual(
                verify.VERIFY_CACHE,
                {"msg-a": " 🔏✓", "msg-b": " 🔏✗UNVERIFIED"},
            )
            verify.load_verify_cache(Path(tmp) / "missing.json")
            (Path(tmp) / "bad.json").write_text("{not json")
            verify.load_verify_cache(Path(tmp) / "bad.json")
            self.assertEqual(
                verify.VERIFY_CACHE,
                {"msg-a": " 🔏✓", "msg-b": " 🔏✗UNVERIFIED"},
            )
        verify.VERIFY_CACHE.clear()

    def test_verify_badge_pending_on_cache_miss_no_subprocess(self):
        from porch3.verify import clear_trust_context

        verify.VERIFY_CACHE.clear()
        clear_trust_context()
        signed = {
            "id": "signed-1",
            "from": "mara",
            "sent": "2025-01-05 00:01:00 -0400",
            "body": "🦊🔏 hello [signed:20250105T000100Z]",
        }
        unsigned = {
            "id": "bare-1",
            "from": "juniper",
            "sent": "2025-01-05 00:02:00 -0400",
            "body": "🦊 hello",
        }

        def boom(*args, **kwargs):
            raise AssertionError("verify_badge must not run live verification")

        with patch.object(verify, "_verify_once", side_effect=boom):
            self.assertEqual(verify.verify_badge(signed), " 🔏…")
            self.assertEqual(verify.verify_badge(unsigned), "")
            verify.VERIFY_CACHE["signed-1"] = " 🔏✓"
            self.assertEqual(verify.verify_badge(signed), " 🔏✓")
        verify.VERIFY_CACHE.clear()

    def test_load_new_skips_known_stems(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_message(root, "commons", "001", "juniper", "2025-01-05 00:01:00 -0400", "first")
            write_message(root, "commons", "002", "finch", "2025-01-05 00:02:00 -0400", "second")
            write_message(root, "commons", "003", "mara", "2025-01-05 00:03:00 -0400", "third")
            seen = {"001", "002"}
            parsed = []
            real_parse = store.parse_msg

            def tracking_parse(path):
                parsed.append(path.stem)
                return real_parse(path)

            with patch.object(store, "parse_msg", side_effect=tracking_parse):
                fresh = store.load_new("commons", seen, root)
            self.assertEqual([m["id"] for m in fresh], ["003"])
            self.assertEqual(parsed, ["003"])


class SenderLabelTests(unittest.TestCase):
    def test_profile_rendering(self):
        cases = [
            ({"from": "mara", "display_name": None, "pfp": "🗽"}, "🗽 mara"),
            ({"from": "juniper", "display_name": "juniper", "pfp": "🌉"}, "🌉 juniper"),
            (
                {"from": "juniper", "display_name": "Juniper", "pfp": "🏮"},
                "🏮 Juniper (juniper)",
            ),
            (
                {"from": "x", "display_name": "evil‮name", "pfp": " "},
                "\\u2028 evil\\u202ename (x)",
            ),
            ({"from": "plain", "display_name": None, "pfp": None}, "plain"),
        ]
        for m, expected in cases:
            self.assertEqual(store.sender_label(m), expected)


class DisplaySanitizeTests(unittest.TestCase):
    def test_csi_osc_bidi_become_visible(self):
        from porch3.sanitize import contains_raw_controls, sanitize_display

        csi = "A\x1b[2JB"
        osc52 = "x\x1b]52;c;QUJDRA==\x07y"
        bidi = "evil\u202ename"
        for raw in (csi, osc52, bidi):
            cleaned = sanitize_display(raw)
            self.assertFalse(contains_raw_controls(cleaned), cleaned)
            self.assertNotIn("\x1b", cleaned)
            self.assertNotIn("\x07", cleaned)
            self.assertNotIn("\u202e", cleaned)

    def test_preserves_newline_tab(self):
        from porch3.sanitize import sanitize_display

        self.assertEqual(sanitize_display("a\nb\tc"), "a\nb\tc")

    def test_highlight_mentions_sanitizes_before_text(self):
        clear_rooms_cache()
        rooms = frozenset({"mara", "juniper"})
        hostile = "hey @juniper \x1b[2J and [/red] and [link=http://x]y[/link]"
        text = highlight_mentions(hostile, rooms=rooms, owner_room="mara")
        from porch3.sanitize import contains_raw_controls

        self.assertFalse(contains_raw_controls(text.plain))
        self.assertNotIn("\x1b", text.plain)
        self.assertIn("[/red]", text.plain)
        self.assertIn("[link=", text.plain)
        self.assertIn("\u241b", text.plain)  # ESC control picture


class MentionsTest(unittest.TestCase):
    def test_highlight_registered_and_trey_accent(self):
        clear_rooms_cache()
        rooms = frozenset({"mara", "juniper", "juniper"})
        text = highlight_mentions("hey @juniper and @mara and @nobody", rooms=rooms, owner_room="mara")
        plain = text.plain
        self.assertIn("@juniper", plain)
        self.assertIn("@mara", plain)
        # spans exist for the two registered mentions
        spans = list(text.spans)
        self.assertGreaterEqual(len(spans), 2)
        # mara uses distinct style
        trey_spans = [s for s in spans if "@mara" in plain[s.start : s.end]]
        pact_spans = [s for s in spans if "@juniper" in plain[s.start : s.end]]
        self.assertTrue(trey_spans and pact_spans)
        self.assertNotEqual(str(trey_spans[0].style), str(pact_spans[0].style))

    def test_highlight_mentions_uses_a_custom_owner_accent(self):
        """Item 20: a configured owner_accent must actually style the owner
        mention, not silently fall back to the hardcoded default."""
        clear_rooms_cache()
        rooms = frozenset({"mara", "juniper"})
        custom = "#12AB34"
        text = highlight_mentions(
            "hey @juniper and @mara", rooms=rooms, owner_room="mara", owner_accent=custom,
        )
        plain = text.plain
        spans = list(text.spans)
        trey_span = next(s for s in spans if "@mara" in plain[s.start : s.end])
        pact_span = next(s for s in spans if "@juniper" in plain[s.start : s.end])
        self.assertEqual(str(trey_span.style.color.name), custom.lower())
        self.assertNotEqual(str(trey_span.style), str(pact_span.style))

    def test_mention_pattern_longest_first(self):
        pat = mention_pattern(frozenset({"claude", "juniper"}))
        assert pat is not None
        m = pat.search("ping @juniper please")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "juniper")

    def test_mention_boundaries_match_post_both_directions(self):
        """Finding 8: @mara-extra must NOT highlight as @mara (post does not stamp)."""
        clear_rooms_cache()
        rooms = frozenset({"mara", "juniper"})
        pat = mention_pattern(rooms)
        assert pat is not None
        self.assertIsNone(pat.search("hey @mara-extra"))
        self.assertIsNone(pat.search("x@mara"))
        self.assertIsNotNone(pat.search("hey @mara "))
        self.assertIsNotNone(pat.search("@mara"))
        self.assertIsNone(pat.search("ping @treyé"))
        # Positive: hyphenated registered name still matches when exact
        pat2 = mention_pattern(frozenset({"mara-extra", "mara"}))
        m = pat2.search("hi @mara-extra!")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "mara-extra")


class StoreParseTest(unittest.TestCase):
    def test_v2_preserves_body_boundaries_and_raw_locator(self):
        with tempfile.TemporaryDirectory() as tmp:
            store_dir = Path(tmp) / "commons" / "messages"
            store_dir.mkdir(parents=True)
            mid = "20250106-120000-000000-v20001"
            body = "  leading\r\n\n🦊🔏 bait [signed:FAKE]\ntrailing\t \n"
            locator = {"version": True, "tag": "malformed_but_raw"}
            meta = {
                "id": mid,
                "from": "mara",
                "sent": "2025-01-06 12:00:00 -0400",
                "channel": "commons",
                "signature_ref": locator,
            }
            path = store_dir / f"{mid}.msg"
            path.write_bytes(
                json.dumps(meta, separators=(",", ":")).encode()
                + b"\n---\n"
                + body.encode()
            )

            msg = store.parse_msg(path)
            self.assertIsNotNone(msg)
            assert msg is not None
            self.assertEqual(msg["body"], body)
            self.assertEqual(msg["signature_ref"], locator)
            self.assertTrue(msg["signature_ref_present"])
            self.assertEqual(msg["storage_channel"], "commons")
            self.assertEqual(msg["envelope_channel"], "commons")
            self.assertEqual(store.clean_message_body(msg), body)

    def test_legacy_store_body_and_cleaning_are_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            store_dir = Path(tmp) / "commons" / "messages"
            store_dir.mkdir(parents=True)
            mid = "20250106-120000-000000-v10001"
            meta = {
                "id": mid,
                "from": "mara",
                "sent": "2025-01-06 12:00:00 -0400",
            }
            path = store_dir / f"{mid}.msg"
            path.write_text(
                json.dumps(meta) + "\n---\n  🦊🔏 hello [signed:TAG]  \n"
            )
            msg = store.parse_msg(path)
            self.assertIsNotNone(msg)
            assert msg is not None
            self.assertEqual(msg["body"], "🦊🔏 hello [signed:TAG]")
            self.assertFalse(msg["signature_ref_present"])
            self.assertEqual(store.clean_message_body(msg), "hello")

    def test_array_json_does_not_brick_startup(self):
        """Finding 5: `[]\\n---\\nbody` must skip, not AttributeError."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store_dir = root / "commons" / "messages"
            store_dir.mkdir(parents=True)
            (store_dir / "bad.msg").write_text("[]\n---\nbody\n")
            mid = "20250106-120000-000000-ok0001"
            meta = {
                "id": mid,
                "from": "juniper",
                "sent": "2025-01-06 12:00:00 -0400",
            }
            (store_dir / f"{mid}.msg").write_text(
                json.dumps(meta) + "\n---\nhello\n"
            )
            # Must not raise
            msgs = store.load_all("commons", root)
            self.assertEqual([m["id"] for m in msgs], [mid])
            self.assertIsNone(store.parse_msg(store_dir / "bad.msg"))

    def test_envelope_id_mismatch_skipped_no_poll_dupe(self):
        """Finding 5: envelope id != stem skipped; seen keyed on stem."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store_dir = root / "commons" / "messages"
            store_dir.mkdir(parents=True)
            stem = "20250106-120000-000000-aaaaa1"
            env_id = "20250106-120000-000000-bbbbb2"
            meta = {
                "id": env_id,
                "from": "juniper",
                "sent": "2025-01-06 12:00:00 -0400",
            }
            (store_dir / f"{stem}.msg").write_text(
                json.dumps(meta) + "\n---\nhello\n"
            )
            self.assertIsNone(store.parse_msg(store_dir / f"{stem}.msg"))
            self.assertEqual(store.load_all("commons", root), [])
            # Valid message: seen on stem prevents re-parse every poll
            good = "20250106-120000-000000-ccccc3"
            meta2 = {
                "id": good,
                "from": "juniper",
                "sent": "2025-01-06 12:01:00 -0400",
            }
            (store_dir / f"{good}.msg").write_text(
                json.dumps(meta2) + "\n---\nok\n"
            )
            msgs = store.load_all("commons", root)
            self.assertEqual([m["id"] for m in msgs], [good])
            seen = {m["stem"] for m in msgs}
            self.assertEqual(store.load_new("commons", seen, root), [])


class ImagePathTest(unittest.TestCase):
    def _tiny_png(self, path: Path) -> Path:
        from PIL import Image

        Image.new("RGB", (1, 1), (255, 0, 0)).save(path)
        return path

    def test_detects_spool_images_only_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spool = root / "spool"
            png = self._tiny_png(root / "shot.png")
            spooled = spool_image(png, spool_dir=spool)
            text = f"see {png} and {spooled}"
            # Foreign validated path is NOT auto-listed
            found = find_image_paths(text, auto_only_spool=True, spool_dir=spool)
            self.assertEqual(found, [spooled])
            # Explicit: all validated
            all_found = find_image_paths(
                text, auto_only_spool=False, spool_dir=spool
            )
            self.assertEqual(set(all_found), {png.resolve(), spooled})

    def test_txt_oversized_magic_mismatch_refused(self):
        """Finding 7: .txt, oversized, and magic mismatch are refused."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            txt = root / "notes.txt"
            txt.write_text("not an image")
            with self.assertRaises(ImageValidationError):
                validate_image(txt)

            big = root / "big.png"
            big.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (IMAGE_MAX_BYTES + 1))
            with self.assertRaises(ImageValidationError):
                validate_image(big)

            mismatch = root / "fake.png"
            mismatch.write_bytes(b"not-png-magic" + b"\x00" * 32)
            with self.assertRaises(ImageValidationError):
                validate_image(mismatch)

            # .txt "succeeds" as file but /img must refuse
            body, err = commands.img_body(str(txt), spool_dir=root / "spool")
            self.assertIsNone(body)
            self.assertIsNotNone(err)

    def test_img_command_happy_path_spools(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self._tiny_png(root / "x.png")
            spool = root / "spool"
            body, err = commands.img_body(str(path), spool_dir=spool)
            self.assertIsNone(err)
            self.assertIsNotNone(body)
            self.assertTrue(Path(body).is_file())
            self.assertTrue(str(Path(body).resolve()).startswith(str(spool.resolve())))
            self.assertIsNotNone(commands.img_body("")[1])
            self.assertIsNotNone(commands.img_body("/nope/missing.png")[1])


class CrossedSendTest(unittest.TestCase):
    def test_send_parses_crossed_send_missed(self):
        payload = {
            "ok": False,
            "error": {
                "code": "crossed_send",
                "message": "unread past cursor",
                "details": {
                    "missed": [
                        {
                            "id": "m1",
                            "from": "juniper",
                            "sent": "2025-01-06 12:00:00 -0400",
                            "body": "hello\n",
                        }
                    ]
                },
            },
        }

        class FakeResult:
            returncode = 65
            stdout = json.dumps(payload)
            stderr = ""

        with patch.object(commands.subprocess if False else __import__("porch3.send", fromlist=["subprocess"]).subprocess, "run", return_value=FakeResult()):
            from porch3 import send as send_mod

            with tempfile.TemporaryDirectory() as tmp:
                with patch.object(send_mod.subprocess, "run", return_value=FakeResult()):
                    result = send_as_owner(
                        "commons",
                        "draft text",
                        config=make_porch_config(Path(tmp)),
                    )
            self.assertFalse(result.ok)
            self.assertTrue(result.crossed)
            self.assertEqual(len(result.missed), 1)
            self.assertEqual(result.missed[0]["from"], "juniper")
            self.assertEqual(result.missed[0]["body"], "hello")


class ChannelDescriptionTest(unittest.TestCase):
    def test_reads_description(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chan = root / "commons"
            chan.mkdir()
            (chan / "messages").mkdir()
            (chan / "channel.json").write_text(
                json.dumps({"name": "commons", "description": "the porch"})
            )
            self.assertEqual(store.channel_description("commons", root), "the porch")

    def test_reply_preview_line(self):
        parent = {
            "id": "20250106-120000-000001-abcdef",
            "from": "juniper",
            "body": "🦊 original long message that should truncate somehow",
        }
        child = {
            "id": "child",
            "from": "mara",
            "re": parent["id"],
            "body": "reply",
        }
        line = store.reply_preview_line(child, {parent["id"]: parent})
        self.assertIsNotNone(line)
        self.assertTrue(line.startswith("↳ re "))
        self.assertIn("juniper", line)


class ThemeTest(unittest.TestCase):
    def test_treaty_colors(self):
        t = SenderTheme({"senders": {"mara": "#FFD700", "juniper": "#FF4F00"}})
        self.assertEqual(t.color("mara"), "#FFD700")
        self.assertEqual(t.color("juniper"), "#FF4F00")
        # unknown gets a stable fallback
        self.assertTrue(t.color("newbie").startswith("#"))


if __name__ == "__main__":
    unittest.main()


class HostileHeaderInputsTest(unittest.TestCase):
    """Round-3 finding 3: sent + persisted verify-cache badge are store data
    and must pass the terminal-control boundary at their shared roots."""

    def test_hostile_sent_sanitized_in_fmt_helpers(self):
        from porch3.store import fmt_day, fmt_time

        hostile = "2025-01-06 \x1b[2J:0 -0400"
        self.assertNotIn("\x1b", fmt_time(hostile))
        self.assertNotIn("\x1b", fmt_day("\x1b]52;c;QUJD" + "x" * 10))

    def test_hostile_verify_cache_badge_sanitized(self):
        from porch3 import verify as verify_mod
        from porch3.verify import verify_badge

        msg = {"id": "m-hostile", "body": "🦊🔏 hi [signed:x]"}
        verify_mod.VERIFY_CACHE["m-hostile"] = " \x1b]52;c;QUJD\x07 🔏✓"
        try:
            badge = verify_badge(msg)
        finally:
            verify_mod.VERIFY_CACHE.pop("m-hostile", None)
        self.assertNotIn("\x1b", badge)
        self.assertNotIn("\x07", badge)


class DisplayBodyTest(unittest.TestCase):
    def test_spool_paths_become_image_tokens_foreign_untouched(self):
        import tempfile
        from unittest.mock import patch as _patch

        from porch3 import images as images_mod
        from porch3.images import display_body

        with tempfile.TemporaryDirectory() as td:
            spool = Path(td) / "spool"
            spool.mkdir()
            spooled = spool / "abc123.png"
            spooled.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 8)
            with _patch.object(images_mod, "IMAGE_SPOOL_DIR", spool):
                out = display_body(
                    f"look at {spooled} and /elsewhere/pic.png too", own=True
                )
        self.assertIn("[image 1]", out)
        self.assertNotIn(str(spooled), out)
        self.assertIn("/elsewhere/pic.png", out)

    def test_foreign_sender_keeps_spool_paths_visible(self):
        # own=False: hiding a spool path behind [image N] would erase the
        # operator's only signal that an untrusted sender referenced a local
        # spool file.
        import tempfile
        from unittest.mock import patch as _patch

        from porch3 import images as images_mod
        from porch3.images import display_body

        with tempfile.TemporaryDirectory() as td:
            spool = Path(td) / "spool"
            spool.mkdir()
            spooled = spool / "abc123.png"
            spooled.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 8)
            with _patch.object(images_mod, "IMAGE_SPOOL_DIR", spool):
                out = display_body(f"see {spooled}", own=False)
        self.assertIn(str(spooled), out)
        self.assertNotIn("[image", out)


class PruneSpoolTest(unittest.TestCase):
    def test_prunes_old_keeps_new_and_dirs(self) -> None:
        import os
        import time as _time

        from porch3.images import prune_spool

        with tempfile.TemporaryDirectory() as td:
            spool = Path(td)
            old = spool / "old.png"
            new = spool / "new.png"
            sub = spool / "subdir"
            old.write_bytes(b"x")
            new.write_bytes(b"x")
            sub.mkdir()
            stale = _time.time() - 8 * 86400
            os.utime(old, (stale, stale))
            removed = prune_spool(spool_dir=spool, max_age_days=7)
            self.assertEqual(removed, 1)
            self.assertFalse(old.exists())
            self.assertTrue(new.exists())
            self.assertTrue(sub.exists())

    def test_missing_spool_is_noop(self) -> None:
        from porch3.images import prune_spool

        self.assertEqual(
            prune_spool(spool_dir=Path("/nonexistent/porch-spool")), 0
        )
