"""Sidecar creation: O_EXCL, one-value tags, private perms."""

from __future__ import annotations

import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from porch3 import signer
from porch3.send import SendResult
from porch3.signer import Signer
from helpers import make_porch_config


class SidecarCreationTest(unittest.TestCase):
    def test_same_second_writers_get_distinct_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"
            with patch.object(signer, "_utc_stamp", return_value="20250110T120000Z"):
                first_tag, first_path = signer._create_payload(
                    "hello one", sigs_dir=sigs
                )
                second_tag, second_path = signer._create_payload(
                    "hello two", sigs_dir=sigs
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
                lines = path.read_text().splitlines()
                # Tag, first line, and file name are one value — a
                # disagreement here verifies as FORGED.
                self.assertEqual(lines[0], tag)
                self.assertEqual(lines[1], text)

    def test_concurrent_threads_never_share_a_sidecar(self):
        results: list[tuple[str, Path]] = []
        results_lock = threading.Lock()
        barrier = threading.Barrier(6)

        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"

            def make(index: int) -> None:
                barrier.wait()
                tag, path = signer._create_payload(f"body {index}", sigs_dir=sigs)
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
                self.assertEqual(path.read_text().splitlines()[0], tag)

    def test_perms_are_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            sigs = Path(tmp) / "sigs"
            sigs.mkdir(mode=0o755)
            _, path = signer._create_payload("private", sigs_dir=sigs)
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
                signer._create_payload("never lands", sigs_dir=sigs)


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
                signer._create_payload("never written", sigs_dir=sigs)
            self.assertEqual(list(sigs.iterdir()), [])


class SignAndSendFailureTest(unittest.TestCase):
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
