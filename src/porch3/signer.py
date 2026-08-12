"""TUI-lifetime private ssh-agent signer (ported from porch v2)."""

from __future__ import annotations

import os
import secrets
import shutil
import string
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from porch3.config import PorchConfig
from porch3.send import SendResult, send_as_owner

# post's tag parser rejects '-', so collision suffixes stay alphanumeric
# (v0.3 review finding F2).
_SUFFIX_ALPHABET = string.ascii_lowercase + string.digits
_SUFFIX_LEN = 6
_MAX_SIDECAR_ATTEMPTS = 8


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _unlink_quietly(*paths: Path) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _create_payload(text: str, *, sigs_dir: Path) -> tuple[str, Path]:
    """Create the payload sidecar; return (tag, path).

    The tag, the payload's first line, and the file name are one value, so
    they cannot disagree: a mismatch verifies as FORGED. Creation is
    O_EXCL, so a same-second writer in another process loses the race
    loudly and retries under a fresh random suffix instead of overwriting.
    """
    sigs_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(sigs_dir, 0o700)
    base = _utc_stamp()
    for attempt in range(_MAX_SIDECAR_ATTEMPTS):
        if attempt == 0:
            tag = base
        else:
            suffix = "".join(
                secrets.choice(_SUFFIX_ALPHABET) for _ in range(_SUFFIX_LEN)
            )
            tag = f"{_utc_stamp()}{suffix}"
        path = sigs_dir / f"{tag}.txt"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        # Past the O_EXCL create we own the file, so any write failure has
        # to take it back out — an orphan the caller never hears about
        # would sit in sigs/ forever.
        try:
            handle = os.fdopen(fd, "w")
        except OSError:
            os.close(fd)
            _unlink_quietly(path)
            raise
        try:
            with handle:
                handle.write(f"{tag}\n{text}\n")
        except OSError:
            _unlink_quietly(path)
            raise
        return tag, path
    raise OSError(f"could not create a unique payload sidecar in {sigs_dir}")


@dataclass
class ServiceLease:
    """A live porch-mobile signing lease this TUI may borrow (§10)."""

    env: dict
    root: Path
    deadline: float | None = None

    @property
    def deadline_display(self) -> str:
        if self.deadline is None:
            return "an unknown time"
        return time.strftime("%H:%M", time.localtime(self.deadline))


def resolve_service_lease(root=None) -> ServiceLease | None:
    """The armed service lease, or None. Verified state only (§10).

    The socket comes from porchd's own state root and is accepted only
    where porchd proves it lies beneath that root; an inherited
    SSH_AUTH_SOCK is never consulted and SSH_AGENT_PID is stripped, so a
    borrowed session cannot end up talking to — or signalling — some
    other agent it happened to inherit.
    """
    try:
        from porchd import lease as service_lease
        from porchd.state import default_root
    except ImportError:
        return None
    try:
        state_root = Path(root) if root is not None else default_root()
        env = service_lease.agent_env(state_root)
        if env is None:
            return None
        # Live ssh-add -l against that socket — the loaded identity is the
        # authorization, the stored deadline is only for display.
        if not service_lease.is_armed(state_root):
            return None
        ends = service_lease.deadline(state_root)
    except OSError:
        return None
    env = {
        key: value
        for key, value in env.items()
        if key != "SSH_AGENT_PID"
    }
    return ServiceLease(env=env, root=state_root, deadline=ends)


class Signer:
    """The session's signing agent, owned or borrowed.

    Owned: a TUI-lifetime private ssh-agent, killed on exit, socket
    0700-private. Borrowed: the porch-mobile service's agent (§10) — this
    process is a guest, so exit never kills it, never runs ssh-add -D,
    never removes its socket dir, and never touches its TTL.
    """

    def __init__(self, config: PorchConfig):
        self.config = config
        self.env = None
        self.tmp = None
        self.owns_agent = False
        self.lease: ServiceLease | None = None
        self.last_payload: Path | None = None
        self.last_sig: Path | None = None

    def use_service_lease(self, lease: ServiceLease) -> bool:
        """Borrow the service agent for this session (owns_agent stays False)."""
        self.env = dict(lease.env)
        self.lease = lease
        self.owns_agent = False
        self.tmp = None
        return True

    def _lease_live(self) -> bool:
        """Re-check a borrowed lease at send time. Any doubt is 'dark'."""
        if self.lease is None:
            return False
        try:
            from porchd import lease as service_lease

            return service_lease.is_armed(self.lease.root)
        except (ImportError, OSError):
            return False

    def start(self) -> bool:
        if self.config.signing_disabled:
            return False
        self.tmp = tempfile.mkdtemp(prefix="porch-agent-")
        sock = os.path.join(self.tmp, "agent.sock")
        out = subprocess.run(
            ["ssh-agent", "-a", sock],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        pid = next(
            line.split("=")[1].split(";")[0]
            for line in out.splitlines()
            if line.startswith("SSH_AGENT_PID=")
        )
        self.env = {**os.environ, "SSH_AUTH_SOCK": sock, "SSH_AGENT_PID": pid}
        print(
            "Enter your porch passphrase "
            "(held only by this TUI's private agent):"
        )
        if (
            subprocess.run(
                ["ssh-add", str(self.config.key_file)], env=self.env
            ).returncode
            != 0
        ):
            self.owns_agent = True
            self.stop()
            return False
        self.owns_agent = True
        return True

    def clean_attempt_sidecars(self) -> None:
        """Remove orphan payload + .sig from an uncommitted signed attempt."""
        if self.last_payload is not None:
            self.last_payload.unlink(missing_ok=True)
            self.last_payload = None
        if self.last_sig is not None:
            self.last_sig.unlink(missing_ok=True)
            self.last_sig = None

    def retain_attempt_sidecars(self) -> None:
        """Keep sidecars after a committed-output failure (do not unlink)."""
        self.last_payload = None
        self.last_sig = None

    def sign_and_send(
        self, channel: str, text: str, *, anyway: bool = False
    ) -> SendResult:
        if self.config.signing_disabled:
            return SendResult(
                ok=False,
                error_code="sign_failed",
                message=(
                    "signing disabled — owner fields disagree with "
                    f"post ({self.config.signing_disabled_reason})"
                ),
            )
        if self.lease is not None and not self._lease_live():
            # Lock, service stop, or TTL expiry between launch and Enter.
            # Fail the signed send closed — the app keeps the draft and
            # there is no unsigned fallback (P1).
            return SendResult(
                ok=False,
                error_code="sign_failed",
                message=(
                    "mobile lease is dark (locked or expired) — "
                    "signed send refused, draft kept"
                ),
            )
        try:
            ts, payload = _create_payload(text, sigs_dir=self.config.sigs_dir)
        except OSError:
            self.last_payload = None
            self.last_sig = None
            return SendResult(ok=False, error_code="sign_failed", message="SIGN FAILED")
        # Both sidecar paths are known before ssh-keygen runs, so every
        # failure below can remove a half-written .sig as well as the
        # payload. Nothing has been sent yet on any of these paths.
        sig = Path(str(payload) + ".sig")
        try:
            r = subprocess.run(
                [
                    "ssh-keygen",
                    "-Y",
                    "sign",
                    "-f",
                    f"{self.config.key_file}.pub",
                    "-n",
                    self.config.signing_namespace,
                    str(payload),
                ],
                env=self.env,
                capture_output=True,
            )
        except OSError:
            _unlink_quietly(payload, sig)
            self.last_payload = None
            self.last_sig = None
            return SendResult(ok=False, error_code="sign_failed", message="SIGN FAILED")
        if r.returncode != 0:
            _unlink_quietly(payload, sig)
            self.last_payload = None
            self.last_sig = None
            return SendResult(ok=False, error_code="sign_failed", message="SIGN FAILED")
        sig_exists = sig.exists()
        if sig_exists:
            try:
                os.chmod(sig, 0o600)
            except OSError:
                pass
        self.last_payload = payload
        self.last_sig = sig if sig_exists else None
        try:
            result = send_as_owner(
                channel,
                self.config.wire.prefix_signed(text, ts),
                config=self.config,
                raw=True,
                anyway=anyway,
            )
        except OSError:
            # OSError here is a pre-exec spawn failure (`post` missing, cwd
            # gone) — post never ran, so nothing committed and both orphan
            # sidecars go. A post that did run reports through SendResult.
            self.clean_attempt_sidecars()
            return SendResult(
                ok=False, error_code="send_failed", message="SEND FAILED"
            )
        if result.ok:
            # Committed + delivered — keep sidecars for porch-verify
            self.retain_attempt_sidecars()
        return result

    def stop(self) -> None:
        if not self.owns_agent:
            # Borrowed lease: the service owns this agent and its TTL is the
            # enforcement clock. A guest never kills it, never clears its
            # identities, and never removes its socket dir — dropping the
            # env is the whole of our cleanup.
            self.env = None
            self.lease = None
            return
        if self.env:
            subprocess.run(
                ["ssh-agent", "-k"], env=self.env, capture_output=True
            )
            self.env = None
        if self.tmp:
            shutil.rmtree(self.tmp, ignore_errors=True)
            self.tmp = None
