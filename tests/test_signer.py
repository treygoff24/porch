"""Signed-v2 manifest production, sidecars, and Post transport."""

from __future__ import annotations

import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from porch3 import signer
from porch3 import send as send_mod
from porch3.send import SendResult, send_as_owner
from porch3.signature_v2 import (
    MAX_SIGNED_BODY_BYTES,
    POST_DEFAULT_BODY_BYTES,
    manifest_bytes,
)
from porch3.signer import Signer
from helpers import make_porch_config


class SidecarCreationTest(unittest.TestCase):
    def test_same_second_writers_get_distinct_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"
            with patch.object(signer, "_utc_stamp", return_value="20250110T120000Z"):
                first_tag, first_path = signer._create_payload(
                    "hello one", channel="commons", sigs_dir=sigs
                )
                second_tag, second_path = signer._create_payload(
                    "hello two", channel="commons", sigs_dir=sigs
                )
            self.assertNotEqual(first_path, second_path)
            self.assertEqual(first_tag, "20250110T120000Z")
            self.assertTrue(second_tag.startswith("20250110T120000Z"))
            self.assertTrue(second_tag.isalnum(), second_tag)
            for tag, path, text in (
                (first_tag, first_path, "hello one"),
                (second_tag, second_path, "hello two"),
            ):
                self.assertEqual(path.name, f"{tag}.txt")
                self.assertEqual(
                    path.read_bytes(), manifest_bytes(tag, "commons", text)
                )

    def test_concurrent_threads_never_share_a_sidecar(self):
        results: list[tuple[str, Path]] = []
        results_lock = threading.Lock()
        barrier = threading.Barrier(6)

        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"

            def make(index: int) -> None:
                barrier.wait()
                tag, path = signer._create_payload(
                    f"body {index}", channel="commons", sigs_dir=sigs
                )
                with results_lock:
                    results.append((tag, path))

            with patch.object(signer, "_utc_stamp", return_value="20250110T120000Z"):
                threads = [
                    threading.Thread(target=make, args=(i,)) for i in range(6)
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
            self.assertEqual(len(results), 6)
            self.assertEqual(len({path for _, path in results}), 6)
            for tag, path in results:
                self.assertEqual(
                    path.read_bytes()[: len(b"porch-signed-v2\n")],
                    b"porch-signed-v2\n",
                )
                self.assertEqual(path.name, f"{tag}.txt")

    def test_perms_are_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"
            sigs.mkdir(mode=0o755)
            _, path = signer._create_payload(
                "private", channel="commons", sigs_dir=sigs
            )
            self.assertEqual(stat.S_IMODE(sigs.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_exhausted_attempts_raise(self):
        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"

            real_open = os.open

            def taken_in_sigs(path, *args, **kwargs):
                if str(path).startswith(str(sigs)):
                    raise FileExistsError(path)
                return real_open(path, *args, **kwargs)

            with patch.object(
                signer.os, "open", side_effect=taken_in_sigs
            ), self.assertRaises(OSError):
                signer._create_payload(
                    "never lands", channel="commons", sigs_dir=sigs
                )


class SidecarWriteFailureTest(unittest.TestCase):
    def test_write_failure_leaves_no_orphan(self):
        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"
            real_fdopen = os.fdopen

            def exploding_fdopen(fd, *args, **kwargs):
                handle = real_fdopen(fd, *args, **kwargs)
                handle.write = lambda *a, **k: (_ for _ in ()).throw(
                    OSError("disk full")
                )
                return handle

            with patch.object(
                signer.os, "fdopen", side_effect=exploding_fdopen
            ), self.assertRaises(OSError):
                signer._create_payload(
                    "never written", channel="commons", sigs_dir=sigs
                )
            self.assertEqual(list(sigs.iterdir()), [])


class ManifestTest(unittest.TestCase):
    def test_exact_ascii_manifest_binds_raw_utf8_body(self):
        tag = "20260812T203000Zabc123"
        body = " first\r\n\rline\n\u2028\u2029\x00e\u0301👩‍🚀🦊🔏 [signed:BAIT]\t\n"
        expected = (
            "porch-signed-v2\n"
            f"tag: {tag}\n"
            "channel: commons\n"
            f"bytes: {len(body.encode('utf-8'))}\n"
            "sha256: "
            "1fdee400fc1199ae6cb6d66e9625640bdb0b5631f18f31314da330a9803642e7\n"
        ).encode("ascii")
        self.assertEqual(manifest_bytes(tag, "commons", body), expected)
        self.assertEqual(expected.count(b"\n"), 5)
        self.assertTrue(expected.endswith(b"\n"))
        self.assertFalse(expected.endswith(b"\n\n"))

    def test_manifest_refuses_ambiguous_tag_or_channel_lines(self):
        for tag in ("", "bad/tag", "bad_tag", "tag\nextra"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                manifest_bytes(tag, "commons", "body")
        for channel in ("", "../commons", "bad/channel", "bad\nchannel"):
            with self.subTest(channel=channel), self.assertRaises(ValueError):
                manifest_bytes("TAG1", channel, "body")

    def test_manifest_encodes_valid_unicode_channel_as_utf8(self):
        manifest = manifest_bytes("TAG1", "機械室", "body")
        self.assertIn("channel: 機械室\n".encode(), manifest)


class SignAndSendFailureTest(unittest.TestCase):
    def _signed_result(self, text: str) -> tuple[SendResult, bytes, tuple]:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            signer_obj = Signer(cfg)
            sent = []

            class Signed:
                returncode = 0

            def wrote_sig(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("SIGNATURE")
                return Signed()

            def fake_send(*args, **kwargs):
                sent.append((args, kwargs))
                return SendResult(ok=True, message="sent")

            with patch.object(signer.subprocess, "run", side_effect=wrote_sig), patch.object(
                signer, "send_as_owner", side_effect=fake_send
            ):
                result = signer_obj.sign_and_send("commons", text)
            payloads = list(cfg.sigs_dir.glob("*.txt"))
            self.assertEqual(len(payloads), 1)
            return result, payloads[0].read_bytes(), sent[0]

    def test_multiline_and_carriage_returns_are_signed_without_decoration(self):
        body = "first\r\nsecond\rthird\n\n🦊🔏 [signed:BAIT]\t\n"
        result, payload, call = self._signed_result(body)
        self.assertTrue(result.ok)
        args, kwargs = call
        self.assertEqual(args[:2], ("commons", body))
        self.assertTrue(kwargs["raw"])
        self.assertRegex(kwargs["signature_ref"], r"^[0-9A-Za-z-]+$")
        self.assertEqual(
            payload,
            manifest_bytes(kwargs["signature_ref"], "commons", body),
        )

    def test_exactly_one_mib_is_signed(self):
        body = "x" * MAX_SIGNED_BODY_BYTES
        result, payload, call = self._signed_result(body)
        self.assertTrue(result.ok)
        self.assertIn(
            f"bytes: {MAX_SIGNED_BODY_BYTES}\n".encode("ascii"), payload
        )
        self.assertEqual(call[0][1], body)

    def test_over_one_mib_is_refused_before_sidecars_or_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            signer_obj = Signer(cfg)
            with patch.object(
                signer,
                "_create_payload",
                side_effect=AssertionError("payload creation must not run"),
            ), patch.object(
                signer.subprocess,
                "run",
                side_effect=AssertionError("ssh-keygen must not run"),
            ), patch.object(
                signer,
                "send_as_owner",
                side_effect=AssertionError("post must not run"),
            ):
                result = signer_obj.sign_and_send(
                    "commons", "x" * (MAX_SIGNED_BODY_BYTES + 1)
                )
            self.assertFalse(result.ok)
            self.assertEqual(result.error_code, "sign_failed")
            self.assertIn("1,048,576-byte limit", result.message)
            self.assertFalse(cfg.sigs_dir.exists())

    def test_sign_failure_removes_the_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            sigs = cfg.sigs_dir

            class Failed:
                returncode = 1

            with patch.object(signer.subprocess, "run", return_value=Failed()):
                result = Signer(cfg).sign_and_send("commons", "nope")
            self.assertFalse(result.ok)
            self.assertEqual(result.error_code, "sign_failed")
            self.assertEqual(list(sigs.iterdir()) if sigs.exists() else [], [])


class SendTransportTest(unittest.TestCase):
    def _send(self, body: str, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))

            class Posted:
                returncode = 0
                stdout = json.dumps({"ok": True})
                stderr = ""

            with patch.object(
                send_mod.subprocess, "run", return_value=Posted()
            ) as run:
                result = send_as_owner(
                    "commons", body, config=cfg, raw=True, **kwargs
                )
            self.assertTrue(result.ok)
            return run.call_args

    def test_signed_body_is_streamed_exactly_and_never_placed_in_argv(self):
        body = "\x00first\r\nsecond\n\u2028👩‍🚀\t "
        call = self._send(body, signature_ref="TAG1")
        cmd = call.args[0]
        self.assertNotIn(body, cmd)
        self.assertIn("--body-file", cmd)
        self.assertIn("/dev/stdin", cmd)
        self.assertEqual(cmd[cmd.index("--signature-ref") + 1], "TAG1")
        self.assertEqual(call.kwargs["input"], body)
        self.assertTrue(call.kwargs["text"])
        self.assertEqual(call.kwargs["encoding"], "utf-8")

    def test_signed_oversize_flag_is_added_only_above_post_default(self):
        at_limit = self._send(
            "x" * POST_DEFAULT_BODY_BYTES, signature_ref="TAG1"
        )
        above = self._send(
            "x" * (POST_DEFAULT_BODY_BYTES + 1), signature_ref="TAG1"
        )
        self.assertNotIn("--oversize", at_limit.args[0])
        self.assertIn("--oversize", above.args[0])

    def test_anyway_and_unsigned_prefix_behavior_are_preserved(self):
        signed = self._send("body", signature_ref="TAG1", anyway=True)
        self.assertIn("--anyway", signed.args[0])

        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))

            class Posted:
                returncode = 0
                stdout = json.dumps({"ok": True})
                stderr = ""

            with patch.object(
                send_mod.subprocess, "run", return_value=Posted()
            ) as run:
                send_as_owner("commons", "hello", config=cfg)
            self.assertEqual(
                run.call_args.kwargs["input"], cfg.wire.prefix_casual("hello")
            )
            self.assertNotIn("--signature-ref", run.call_args.args[0])

    def test_sign_failure_removes_a_partial_signature(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            sigs = cfg.sigs_dir

            class Failed:
                returncode = 1

            def half_written_sig(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("PARTIAL")
                return Failed()

            with patch.object(
                signer.subprocess, "run", side_effect=half_written_sig
            ):
                result = Signer(cfg).sign_and_send("commons", "nope")
            self.assertFalse(result.ok)
            self.assertEqual(result.error_code, "sign_failed")
            self.assertEqual(list(sigs.iterdir()) if sigs.exists() else [], [])

    def test_ssh_keygen_spawn_failure_cleans_both_sidecars(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            sigs = cfg.sigs_dir

            def missing_binary(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("PARTIAL")
                raise OSError("ssh-keygen not found")

            with patch.object(
                signer.subprocess, "run", side_effect=missing_binary
            ):
                result = Signer(cfg).sign_and_send("commons", "nope")
            self.assertFalse(result.ok)
            self.assertEqual(result.error_code, "sign_failed")
            self.assertEqual(list(sigs.iterdir()) if sigs.exists() else [], [])

    def test_send_spawn_failure_cleans_both_sidecars(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            sigs = cfg.sigs_dir

            class Signed:
                returncode = 0

            def wrote_sig(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("SIGNATURE")
                return Signed()

            with patch.object(
                signer.subprocess, "run", side_effect=wrote_sig
            ), patch.object(
                signer, "send_as_owner", side_effect=OSError("post not found")
            ):
                result = Signer(cfg).sign_and_send("commons", "nope")
            self.assertFalse(result.ok)
            self.assertEqual(result.error_code, "send_failed")
            self.assertEqual(list(sigs.iterdir()) if sigs.exists() else [], [])

    def test_committed_failure_still_retains_sidecars(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            sigs = cfg.sigs_dir

            class Signed:
                returncode = 0

            def wrote_sig(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("SIGNATURE")
                return Signed()

            committed = SendResult(
                ok=False,
                error_code="delivered_output_failure",
                message="committed",
            )
            with patch.object(
                signer.subprocess, "run", side_effect=wrote_sig
            ), patch.object(signer, "send_as_owner", return_value=committed):
                signer_obj = Signer(cfg)
                result = signer_obj.sign_and_send("commons", "landed")
            self.assertTrue(result.committed)
            # The app calls retain_attempt_sidecars() on this path; the
            # files must still be on disk for porch-verify.
            self.assertEqual(len(list(sigs.iterdir())), 2)
            self.assertIsNotNone(signer_obj.last_payload)

    def test_unique_sidecar_exhaustion_reports_sign_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            with patch.object(
                signer, "_create_payload", side_effect=OSError("no slot")
            ):
                result = Signer(cfg).sign_and_send("commons", "nope")
            self.assertFalse(result.ok)
            self.assertEqual(result.error_code, "sign_failed")


if __name__ == "__main__":
    unittest.main()
