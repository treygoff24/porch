"""Borrowed porch-mobile signing lease in the TUI (SPEC §10, §3)."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from porch3 import signer as signer_mod
from porch3.signer import ServiceLease, Signer, resolve_service_lease
from helpers import make_porch_config


def make_service_root(tmp: str, *, socket_inside: bool = True) -> tuple[Path, Path]:
    """A porchd state root with an agent socket recorded in agent.json."""
    root = Path(tmp) / "porchd"
    agent_dir = root / "agent" / "deadbeef"
    agent_dir.mkdir(parents=True)
    if socket_inside:
        sock = agent_dir / "agent.sock"
    else:
        outside = Path(tmp) / "elsewhere"
        outside.mkdir()
        sock = outside / "agent.sock"
    sock.touch()
    (root / "agent.json").write_text(json.dumps({"socket": str(sock)}))
    return root, sock


def armed_ssh_add(returncode: int = 0, identities: str = "256 SHA256:x mara (ED25519)\n"):
    class Result:
        def __init__(self):
            self.returncode = returncode
            self.stdout = identities
            self.stderr = ""

    def run(cmd, **kwargs):
        return Result()

    return run


class ResolveServiceLeaseTest(unittest.TestCase):
    def test_armed_service_lease_is_offered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, sock = make_service_root(tmp)
            deadline = time.time() + 3600
            (root / "lease.json").write_text(json.dumps({"deadline": deadline}))
            from porchd import lease as service_lease

            with patch.object(
                service_lease.subprocess, "run", side_effect=armed_ssh_add()
            ):
                lease = resolve_service_lease(root)
            self.assertIsNotNone(lease)
            self.assertEqual(lease.env["SSH_AUTH_SOCK"], str(sock))
            self.assertEqual(lease.deadline, deadline)
            self.assertRegex(lease.deadline_display, r"^\d{2}:\d{2}$")

    def test_dark_service_lease_is_not_offered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, _ = make_service_root(tmp)
            from porchd import lease as service_lease

            with patch.object(
                service_lease.subprocess,
                "run",
                side_effect=armed_ssh_add(identities=""),
            ):
                self.assertIsNone(resolve_service_lease(root))

    def test_socket_outside_the_state_root_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, _ = make_service_root(tmp, socket_inside=False)
            from porchd import lease as service_lease

            with patch.object(
                service_lease.subprocess, "run", side_effect=armed_ssh_add()
            ):
                self.assertIsNone(resolve_service_lease(root))

    def test_inherited_ssh_auth_sock_is_never_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, sock = make_service_root(tmp)
            inherited = Path(tmp) / "inherited.sock"
            inherited.touch()
            from porchd import lease as service_lease

            env = {
                "SSH_AUTH_SOCK": str(inherited),
                "SSH_AGENT_PID": "4242",
                "PATH": "/usr/bin",
            }
            with patch.dict(service_lease.os.environ, env, clear=True), patch.object(
                service_lease.subprocess, "run", side_effect=armed_ssh_add()
            ):
                lease = resolve_service_lease(root)
            self.assertIsNotNone(lease)
            # The service socket wins, and the inherited agent's pid is
            # stripped so nothing downstream can signal it.
            self.assertEqual(lease.env["SSH_AUTH_SOCK"], str(sock))
            self.assertNotIn("SSH_AGENT_PID", lease.env)

    def test_missing_service_state_is_simply_no_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(resolve_service_lease(Path(tmp) / "absent"))


class BorrowedExitTest(unittest.TestCase):
    def test_exit_never_kills_or_clears_the_service_agent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, sock = make_service_root(tmp)
            lease = ServiceLease(
                env={"SSH_AUTH_SOCK": str(sock)}, root=root, deadline=None
            )
            signer = Signer(make_porch_config(Path(tmp)))
            signer.use_service_lease(lease)
            self.assertFalse(signer.owns_agent)

            calls: list[list[str]] = []

            def record(cmd, **kwargs):
                calls.append(list(cmd))
                raise AssertionError(f"borrowed exit must not run {cmd}")

            with patch.object(signer_mod.subprocess, "run", side_effect=record), \
                    patch.object(signer_mod.shutil, "rmtree") as rmtree:
                signer.stop()

            self.assertEqual(calls, [])
            rmtree.assert_not_called()
            # The service's socket and its directory outlive our exit.
            self.assertTrue(sock.exists())
            self.assertTrue(sock.parent.is_dir())
            self.assertIsNone(signer.env)

    def test_owned_agent_exit_still_kills_and_cleans(self):
        with tempfile.TemporaryDirectory() as tmp:
            signer = Signer(make_porch_config(Path(tmp)))

            class Started:
                returncode = 0
                stdout = "SSH_AGENT_PID=999;\n"

            with patch.object(
                signer_mod.subprocess, "run", return_value=Started()
            ):
                self.assertTrue(signer.start())
            self.assertTrue(signer.owns_agent)
            tmpdir = signer.tmp

            calls: list[list[str]] = []

            def record(cmd, **kwargs):
                calls.append(list(cmd))
                return Started()

            with patch.object(signer_mod.subprocess, "run", side_effect=record):
                signer.stop()

            self.assertEqual(calls, [["ssh-agent", "-k"]])
            self.assertFalse(Path(tmpdir).exists())


class BorrowedSendTest(unittest.TestCase):
    def _borrowed(self, tmp: str) -> tuple[Signer, Path]:
        root, sock = make_service_root(tmp)
        lease = ServiceLease(
            env={"SSH_AUTH_SOCK": str(sock)}, root=root, deadline=None
        )
        signer = Signer(make_porch_config(Path(tmp)))
        signer.use_service_lease(lease)
        return signer, root

    def test_expiry_mid_session_fails_the_send_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            signer, _ = self._borrowed(tmp)
            sigs = signer.config.sigs_dir
            sent: list[str] = []

            with patch.object(
                signer_mod, "send_as_owner", side_effect=lambda *a, **k: sent.append(a)
            ), patch.object(Signer, "_lease_live", return_value=False):
                result = signer.sign_and_send("commons", "while dark")

            self.assertFalse(result.ok)
            self.assertIn("dark", result.message)
            # No unsigned fallback, no sidecar, nothing sent (P1).
            self.assertEqual(sent, [])
            self.assertFalse(sigs.exists())

    def test_live_lease_signs_and_sends(self):
        with tempfile.TemporaryDirectory() as tmp:
            signer, _ = self._borrowed(tmp)
            sent: list[tuple] = []

            class Signed:
                returncode = 0

            def wrote_sig(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("SIGNATURE")
                return Signed()

            from porch3.send import SendResult

            def fake_send(channel, body, **kwargs):
                sent.append((channel, body, kwargs))
                return SendResult(ok=True, message="sent")

            with patch.object(
                signer_mod.subprocess, "run", side_effect=wrote_sig
            ), patch.object(
                signer_mod, "send_as_owner", side_effect=fake_send
            ), patch.object(Signer, "_lease_live", return_value=True):
                result = signer.sign_and_send("commons", "while armed")

            self.assertTrue(result.ok)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0][1], "while armed")
            self.assertTrue(sent[0][2]["raw"])
            self.assertRegex(sent[0][2]["signature_ref"], r"^[0-9A-Za-z-]+$")

    def test_private_signer_path_is_unaffected_by_the_lease_check(self):
        """No lease → no re-check, the owned-agent path is untouched."""
        with tempfile.TemporaryDirectory() as tmp:
            cfg = make_porch_config(Path(tmp))
            signer = Signer(cfg)
            signer.env = {"SSH_AUTH_SOCK": "/private/agent.sock"}
            signer.owns_agent = True
            self.assertIsNone(signer.lease)

            class Signed:
                returncode = 0

            def wrote_sig(cmd, **kwargs):
                Path(str(cmd[-1]) + ".sig").write_text("SIGNATURE")
                return Signed()

            from porch3.send import SendResult

            with patch.object(
                signer_mod.subprocess, "run", side_effect=wrote_sig
            ), patch.object(
                signer_mod,
                "send_as_owner",
                return_value=SendResult(ok=True, message="sent"),
            ), patch.object(
                Signer, "_lease_live", side_effect=AssertionError("must not check")
            ):
                result = signer.sign_and_send("commons", "private")

            self.assertTrue(result.ok)


class LaunchPromptTest(unittest.TestCase):
    """The third launch option (§10): offered, declinable, never inferred."""

    def _run_main(self, tmp, lease, answers):
        from porch3 import app as app_mod

        asked: list[str] = []
        captured: dict = {}
        cfg = make_porch_config(Path(tmp))
        cfg.key_file.touch()
        store = cfg.channels_dir / "commons" / "messages"
        store.mkdir(parents=True)

        class FakeApp:
            def __init__(self, *, porch_config, channel, signer):
                captured["signer"] = signer

            def run(self):
                captured["owns_agent"] = captured["signer"].owns_agent
                captured["env"] = captured["signer"].env

        def fake_input(prompt):
            asked.append(prompt)
            return answers.pop(0)

        with patch.object(app_mod, "PorchApp", FakeApp), \
                patch.object(app_mod, "load_verify_cache"), \
                patch.object(app_mod, "resolve_service_lease", return_value=lease), \
                patch.object(app_mod.sys.stdin, "isatty", return_value=True), \
                patch.object(app_mod, "load_config", return_value=cfg), \
                patch("porch3.roomcheck.assert_acting_room", lambda config: None), \
                patch("porch3.roomcheck.apply_owner_crosscheck", lambda config: config), \
                patch("builtins.input", fake_input):
            app_mod.main([])
        return asked, captured

    def test_armed_lease_is_offered_and_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease = ServiceLease(
                env={"SSH_AUTH_SOCK": "/state/agent.sock"},
                root=Path(tmp),
                deadline=time.time() + 3600,
            )
            asked, captured = self._run_main(tmp, lease, [""])
            self.assertEqual(len(asked), 1)
            self.assertIn("mobile lease is ARMED until", asked[0])
            self.assertIn("[Y/n]", asked[0])
            self.assertFalse(captured["owns_agent"])
            self.assertEqual(
                captured["env"]["SSH_AUTH_SOCK"], "/state/agent.sock"
            )

    def test_declining_the_lease_falls_through_to_the_private_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease = ServiceLease(
                env={"SSH_AUTH_SOCK": "/state/agent.sock"},
                root=Path(tmp),
                deadline=time.time() + 3600,
            )
            asked, captured = self._run_main(tmp, lease, ["n", "n"])
            self.assertEqual(len(asked), 2)
            self.assertIn("mobile lease is ARMED", asked[0])
            self.assertIn("Enable signed sends", asked[1])
            self.assertIsNone(captured["env"])

    def test_no_lease_asks_only_the_original_question(self):
        with tempfile.TemporaryDirectory() as tmp:
            asked, captured = self._run_main(tmp, None, ["n"])
            self.assertEqual(len(asked), 1)
            self.assertIn("Enable signed sends", asked[0])
            self.assertIsNone(captured["env"])


if __name__ == "__main__":
    unittest.main()
