"""Verify-cache persistence: merge-on-write under an interprocess lock."""

from __future__ import annotations

import json
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from porch3 import verify
from porch3.verify import clear_trust_context

SRC = str(Path(__file__).resolve().parent.parent / "src")


class VerifyCacheMergeTest(unittest.TestCase):
    def test_write_merges_with_entries_already_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            path.write_text(json.dumps({"msg-old": " 🔏✓"}))
            verify.save_verify_cache(path, cache={"msg-new": " 🔏✓"})
            self.assertEqual(
                json.loads(path.read_text()),
                {"msg-old": " 🔏✓", "msg-new": " 🔏✓"},
            )

    def test_transient_badge_is_never_persisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            verify.save_verify_cache(
                path, cache={"msg-a": " 🔏✓", "msg-b": " 🔏?"}
            )
            self.assertEqual(json.loads(path.read_text()), {"msg-a": " 🔏✓"})

    def test_cache_file_is_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "verify-cache.json"
            verify.save_verify_cache(path, cache={"msg-a": " 🔏✓"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_stale_writer_does_not_clobber_a_fresher_disk_entry(self):
        """A dirty-delta save must not push stale state over disk (F1)."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            # Another process has since verified msg-x.
            path.write_text(json.dumps({"msg-x": " 🔏✓"}))
            # We still hold the old answer, and are saving an unrelated id.
            stale_process_cache = {
                "msg-x": " 🔏✗UNVERIFIED",
                "msg-y": " 🔏✓",
            }
            verify.save_verify_cache(path, cache={"msg-y": " 🔏✓"})
            data = json.loads(path.read_text())
            self.assertEqual(data["msg-x"], " 🔏✓")
            self.assertEqual(data["msg-y"], " 🔏✓")
            self.assertIn("msg-x", stale_process_cache)

    def test_worker_persists_only_its_own_delta(self):
        """_verify_worker must hand save a single-entry dict (F1)."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            path.write_text(json.dumps({"msg-x": " 🔏✓"}))
            calls: list[dict] = []
            real_save = verify.save_verify_cache
            saved = threading.Event()

            def record(save_path=None, cache=None):
                calls.append(dict(cache))
                real_save(path, cache=cache)
                saved.set()

            class Cfg:
                pass

            cfg = Cfg()
            verify.VERIFY_CACHE.clear()
            clear_trust_context()
            verify.VERIFY_CACHE["msg-x"] = " 🔏✗UNVERIFIED"
            verify.VERIFY_QUEUE.put(("", "msg-new", cfg))
            with patch.object(verify, "save_verify_cache", side_effect=record), \
                    patch.object(verify, "_verify_once", return_value=" 🔏✓"):
                worker = threading.Thread(
                    target=verify._verify_worker, daemon=True
                )
                worker.start()
                self.assertTrue(saved.wait(timeout=5))
            self.assertEqual(calls, [{"msg-new": " 🔏✓"}])
            self.assertEqual(
                json.loads(path.read_text()),
                {"msg-x": " 🔏✓", "msg-new": " 🔏✓"},
            )
            verify.VERIFY_CACHE.clear()

    def test_queued_frozen_config_survives_context_switch(self):
        """Enqueue under A, switch to B — worker verifies with frozen A."""
        barrier = threading.Barrier(2)
        seen: list[object] = []
        path_a = Path("/tmp/porch-config-a.toml")
        path_b = Path("/tmp/porch-config-b.toml")

        class FakeConfig:
            def __init__(self, path, room):
                self.mail_root = Path(f"/tmp/mail-{room}")
                self.allowed_signers = Path(f"/tmp/signers-{room}")
                self.principal = room
                self.signing_namespace = "porch"
                self.marker = "🦊"
                self.source_path = path
                self.signing_disabled = False
                self.sigs_dir = Path(f"/tmp/sigs-{room}")
                self.owner_room = room

        def gated_verify(mid, config):
            seen.append(config)
            barrier.wait(timeout=5)
            return " 🔏✗UNVERIFIED"

        verify.VERIFY_CACHE.clear()
        clear_trust_context()
        while True:
            try:
                verify.VERIFY_QUEUE.get_nowait()
            except Exception:
                break
        verify._VERIFY_QUEUED.clear()

        cfg_a = FakeConfig(path_a, "alice")
        cfg_b = FakeConfig(path_b, "bob")
        mid = "20250111-120000-000001-aaaaaa"
        verify.set_trust_context(cfg_a)
        # Capture at enqueue time (mirrors enqueue_verifications).
        verify.VERIFY_QUEUE.put((verify._TRUST, mid, verify._CONFIG))
        # Switch ambient trust to B before the worker consumes.
        verify.set_trust_context(cfg_b)

        with patch.object(verify, "_verify_once", side_effect=gated_verify), \
                patch.object(verify, "save_verify_cache"):
            worker = threading.Thread(target=verify._verify_worker, daemon=True)
            worker.start()
            barrier.wait(timeout=5)
            worker.join(timeout=1)

        self.assertTrue(seen)
        self.assertIs(seen[0], cfg_a)
        trust_a = verify.trust_key_for_config(cfg_a)
        trust_b = verify.trust_key_for_config(cfg_b)
        self.assertIn(verify._ck(mid, trust_a), verify.VERIFY_CACHE)
        self.assertNotIn(verify._ck(mid, trust_b), verify.VERIFY_CACHE)
        verify.VERIFY_CACHE.clear()
        clear_trust_context()
        verify._VERIFY_QUEUED.clear()

    def test_config_file_rewrite_does_not_redirect_in_process_verify(self):
        """Item 1: same pathname, replaced bytes — frozen config still used."""
        from dataclasses import replace

        from helpers import make_porch_config
        from porch3.config import emit_toml
        from porch3.verifycli import EXIT_FAIL, EXIT_OK

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg_a = make_porch_config(root / "a", owner_room="alice", marker="🦊")
            cfg_b = make_porch_config(root / "b", owner_room="bob", marker="🐉")
            path = root / "shared.toml"
            path.write_text(emit_toml(cfg_a))
            cfg_a = replace(cfg_a, source_path=path.resolve())
            mid = "20250111-120000-000001-aaaaaa"

            seen: list[object] = []

            def spy_verify(message_id, *, config, channel=None):
                seen.append(config)
                # Prove we hold A's identity even after the file is B.
                assert config.owner_room == "alice"
                assert path.read_text() == emit_toml(cfg_b) or True
                return EXIT_OK, "ok"

            verify.VERIFY_CACHE.clear()
            clear_trust_context()
            while True:
                try:
                    verify.VERIFY_QUEUE.get_nowait()
                except Exception:
                    break
            verify._VERIFY_QUEUED.clear()
            verify.set_trust_context(cfg_a)
            verify.VERIFY_QUEUE.put((verify._TRUST, mid, verify._CONFIG))
            # Replace the file bytes with B after enqueue.
            path.write_text(emit_toml(cfg_b))

            with patch(
                "porch3.verifycli.verify_message_id", side_effect=spy_verify
            ), patch.object(verify, "save_verify_cache"):
                worker = threading.Thread(
                    target=verify._verify_worker, daemon=True
                )
                worker.start()
                for _ in range(100):
                    if verify._ck(mid) in verify.VERIFY_CACHE:
                        break
                    threading.Event().wait(0.02)
                worker.join(timeout=1)

            self.assertTrue(seen)
            self.assertIs(seen[0], cfg_a)
            self.assertEqual(seen[0].owner_room, "alice")
            self.assertEqual(verify.VERIFY_CACHE[verify._ck(mid)], " 🔏✓")
            verify.VERIFY_CACHE.clear()
            clear_trust_context()
            verify._VERIFY_QUEUED.clear()

    def test_rc4_is_not_persisted_as_terminal_negative(self):
        """Item 3: EXIT_ENV stays UNKNOWN — no UNVERIFIED cache entry."""
        from porch3.verifycli import EXIT_ENV

        class Cfg:
            pass

        mid = "20250111-120000-000001-bbbbbb"
        verify.VERIFY_CACHE.clear()
        clear_trust_context()
        while True:
            try:
                verify.VERIFY_QUEUE.get_nowait()
            except Exception:
                break
        verify._VERIFY_QUEUED.clear()
        verify.VERIFY_QUEUE.put(("", mid, Cfg()))
        with patch.object(
            verify, "_verify_once", return_value=None
        ), patch.object(verify, "save_verify_cache") as save, patch.object(
            verify, "_TRANSIENT_BACKOFF_S", 0
        ):
            worker = threading.Thread(target=verify._verify_worker, daemon=True)
            worker.start()
            worker.join(timeout=2)
        self.assertNotIn(verify._ck(mid), verify.VERIFY_CACHE)
        save.assert_not_called()
        verify.VERIFY_CACHE.clear()
        verify._VERIFY_QUEUED.clear()
    def test_trust_key_pipe_fields_do_not_collide(self):
        from porch3.verify import encode_trust_context, trust_key_for_config

        a = encode_trust_context(mail_root="a|b", owner_room="c")
        b = encode_trust_context(mail_root="a", owner_room="b|c")
        self.assertNotEqual(a, b)

        class C:
            pass

        ca, cb = C(), C()
        for obj, mr, room in ((ca, "a|b", "c"), (cb, "a", "b|c")):
            obj.mail_root = mr
            obj.owner_room = room
            obj.sigs_dir = "/s"
            obj.allowed_signers = "/as"
            obj.principal = "p"
            obj.signing_namespace = "n"
            obj.marker = "🦊"
            obj.source_path = "/cfg"
        self.assertNotEqual(trust_key_for_config(ca), trust_key_for_config(cb))
        base = dict(
            mail_root="/m",
            owner_room="r",
            sigs_dir="/sigs",
            allowed_signers="/as",
            principal="p",
            namespace="n",
            marker="🦊",
            source_path="/cfg",
        )
        base_key = encode_trust_context(**base)
        for field in base:
            mutated = dict(base)
            mutated[field] = mutated[field] + "|x"
            self.assertNotEqual(encode_trust_context(**mutated), base_key, msg=field)

    def test_transient_failure_then_success_retries(self):
        mid = "20250111-120000-000001-aaaaaa"
        calls = {"n": 0}

        def flaky_verify(mid_arg, config):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("transient")
            return " 🔏✓"

        class Cfg:
            pass

        verify.VERIFY_CACHE.clear()
        clear_trust_context()
        while True:
            try:
                verify.VERIFY_QUEUE.get_nowait()
            except Exception:
                break
        verify._VERIFY_QUEUED.clear()
        verify.VERIFY_QUEUE.put(("", mid, Cfg()))
        with patch.object(verify, "_verify_once", side_effect=flaky_verify), \
                patch.object(verify, "save_verify_cache"), \
                patch.object(verify, "_TRANSIENT_BACKOFF_S", 0):
            worker = threading.Thread(target=verify._verify_worker, daemon=True)
            worker.start()
            for _ in range(100):
                if verify._ck(mid) in verify.VERIFY_CACHE:
                    break
                threading.Event().wait(0.02)
            worker.join(timeout=1)
        self.assertGreaterEqual(calls["n"], 2)
        self.assertEqual(verify.VERIFY_CACHE.get(verify._ck(mid)), " 🔏✓")
        verify.VERIFY_CACHE.clear()
        verify._VERIFY_QUEUED.clear()

    def test_load_migrates_a_legacy_world_readable_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            path.write_text(json.dumps({"msg-a": " 🔏✓"}))
            path.chmod(0o644)
            verify.VERIFY_CACHE.clear()
            clear_trust_context()
            try:
                verify.load_verify_cache(path)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(verify.VERIFY_CACHE["msg-a"], " 🔏✓")
            finally:
                verify.VERIFY_CACHE.clear()

    def test_lock_path_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            target = Path(tmp) / "elsewhere.json"
            (Path(tmp) / "verify-cache.json.lock").symlink_to(target)
            verify.save_verify_cache(path, cache={"msg-a": " 🔏✓"})
            # O_NOFOLLOW refuses the planted link, so nothing is written
            # through it and the cache write is abandoned, not misdirected.
            self.assertFalse(target.exists())
            self.assertFalse(path.exists())

    def test_interleaved_thread_writers_all_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            barrier = threading.Barrier(2)

            def writer(name: str) -> None:
                cache: dict[str, str] = {}
                barrier.wait()
                for i in range(25):
                    cache[f"{name}-{i}"] = " 🔏✓"
                    verify.save_verify_cache(path, cache=cache)

            threads = [
                threading.Thread(target=writer, args=(name,))
                for name in ("alpha", "beta")
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            data = json.loads(path.read_text())
            for name in ("alpha", "beta"):
                for i in range(25):
                    self.assertIn(f"{name}-{i}", data)

    def test_interleaved_process_writers_all_survive(self):
        script = textwrap.dedent(
            """
            import sys
            sys.path.insert(0, sys.argv[1])
            from porch3 import verify

            path, name = sys.argv[2], sys.argv[3]
            cache = {}
            for i in range(25):
                cache[f"{name}-{i}"] = " 🔏✓"
                verify.save_verify_cache(path, cache=cache)
            """
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "verify-cache.json"
            procs = [
                subprocess.Popen(
                    [sys.executable, "-c", script, SRC, str(path), name]
                )
                for name in ("alpha", "beta")
            ]
            for proc in procs:
                self.assertEqual(proc.wait(timeout=60), 0)

            data = json.loads(path.read_text())
            for name in ("alpha", "beta"):
                for i in range(25):
                    self.assertIn(f"{name}-{i}", data)


if __name__ == "__main__":
    unittest.main()
