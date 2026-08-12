"""porch init — trust-anchor write contract (B0 §3).

Mutates three surfaces in order: keypair → allowed_signers → config LAST.
Never invokes ``post owner init`` (post's ceremony). First preflight is
``post owner show`` with resolved POST_MAIL_ROOT.

Supports interactive prompts (TTY) and non-interactive config-input flags /
``run_init`` kwargs (the test seam).
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import os
import shlex
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Mapping

from porch3.config import (
    CONFIG_PATH,
    ConfigError,
    HeldIOError,
    HeldRegular,
    PorchConfig,
    build_config,
    default_label_for,
    emit_toml,
    held_read_regular_nofollow,
    legacy_hardcoded_values,
    load_config_bytes,
    owner_field_mismatches,
    resolve_mail_root,
)
from porch3.platform import require_macos
from porch3.roomcheck import (
    OwnerShowError,
    RoomInvariantError,
    assert_acting_room,
    fetch_owner_show,
)
from porch3.wire import DEFAULT_MARKER

# Public key files are tiny; refuse anything that looks planted/huge.
_MAX_PUB_BYTES = 16 * 1024
_MAX_KEY_BYTES = 16 * 1024
_MAX_SIGNERS_BYTES = 1 << 20
_MAX_CONFIG_BYTES = 1 << 20


class InitError(Exception):
    def __init__(self, message: str, *, exit_code: int = 2):
        super().__init__(message)
        self.exit_code = exit_code


def _write_all(fd: int, data: bytes) -> None:
    """Full-write: loop until every byte is accepted."""
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write")
        view = view[written:]


def _read_fd_to_eof_bounded(fd: int, *, limit: int, label: str) -> bytes:
    """Read held fd to EOF with a strict limit+1 bound (never trust st_size)."""
    chunks: list[bytes] = []
    total = 0
    while True:
        to_read = min(65536, (limit + 1) - total)
        if to_read <= 0:
            break
        chunk = os.read(fd, to_read)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise InitError(
                f"{label} exceeds {limit} bytes — refuse",
                exit_code=4,
            )
    return b"".join(chunks)


def _read_regular_held(
    path: Path, *, limit: int, label: str
) -> HeldRegular:
    """Shared held-fd reader returning bytes + that fd's fstat snapshot.

    Callers that enforce a mode policy must judge ``held.st`` — a later
    ``os.lstat(path)`` would let the file be swapped between read and check.
    """
    try:
        return held_read_regular_nofollow(path, limit=limit, label=label)
    except FileNotFoundError:
        raise
    except HeldIOError as exc:
        msg = str(exc)
        if msg.startswith("cannot open"):
            detail = (
                f"{label} path {path} exists but is unreadable/non-followable: {exc}"
            )
        elif "regular file" in msg:
            detail = (
                f"{label} at {path} must be a regular file "
                "(symlink/FIFO/directory refused)"
            )
        elif "exceeds" in msg:
            detail = f"{label} at {path} exceeds {limit} bytes — refuse"
        else:
            detail = f"{label} at {path}: {exc}"
        raise InitError(detail, exit_code=4) from exc


def _read_regular_nofollow(
    path: Path, *, limit: int, label: str
) -> bytes:
    """Bytes-only held read for callers with no mode policy to enforce."""
    return _read_regular_held(path, limit=limit, label=label).data


def _hardlink_commit(
    src: Path, dest: Path, *, wanted: bytes, wanted_config: PorchConfig
) -> None:
    """A0a no-replace commit: create_new dest via hard-link from temp file.

    Mid-commit race outcomes (create-only contract):
    - dest absent → link succeeds
    - dest present with resolve-identical PorchConfig → idempotent success
      (byte-identical OR reordered/explicit-defaults with same resolution)
    - dest present with different-valid or malformed → refuse
    """
    try:
        os.link(src, dest)
        return
    except FileExistsError:
        pass
    except OSError as exc:
        raise InitError(
            f"cannot hard-link config onto {dest} from {src}: {exc} "
            "(temp and destination must share a filesystem)"
        ) from exc
    existing = _read_regular_nofollow(
        dest, limit=_MAX_CONFIG_BYTES, label="config"
    )
    if existing == wanted:
        return  # byte-identical raced destination
    try:
        existing_cfg = load_config_bytes(existing, env={})
    except ConfigError as exc:
        raise InitError(
            f"config already exists at {dest} but is malformed: {exc}"
        ) from exc
    if _configs_resolve_identical(existing_cfg, wanted_config):
        return  # resolve-identical (byte-different OK)
    raise InitError(
        f"config already exists at {dest} with different values — refuse"
    )


def _write_config_atomic(config: PorchConfig, path: Path) -> None:
    if path.is_symlink():
        raise InitError(f"refusing symlink at config path {path}")
    if path.exists():
        # Pre-check via O_NOFOLLOW bounded read; hardlink still handles races.
        try:
            existing_bytes = _read_regular_nofollow(
                path, limit=_MAX_CONFIG_BYTES, label="config"
            )
            existing = load_config_bytes(existing_bytes, env={})
        except InitError:
            raise
        except ConfigError as exc:
            raise InitError(
                f"config already exists at {path} but is malformed: {exc}"
            ) from exc
        if _configs_resolve_identical(existing, config):
            return
        raise InitError(
            f"config already exists at {path} with different values — refuse"
        )
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    text = emit_toml(config)
    wanted = text.encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(
        dir=str(parent),
        prefix=".porch-config.",
        suffix=".tmp",
    )
    tmp = Path(tmp_name)
    committed = False
    try:
        os.fchmod(fd, 0o600)
        _write_all(fd, wanted)
        os.fsync(fd)
        os.close(fd)
        fd = -1
        _hardlink_commit(tmp, path, wanted=wanted, wanted_config=config)
        committed = True
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        # Once the hard-link commits, temp cleanup is best-effort: a failed
        # unlink must NOT unwind key/signers (config is the activation marker).
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            if not committed:
                raise


def _is_regular_nofollow(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode)


@contextlib.contextmanager
def _ssh_askpass_env(passphrase: str):
    """SSH_ASKPASS env whose secret never appears in argv or env values.

    The passphrase lives only in a 0600 temp file read by a 0700 askpass
    script. ``SSH_ASKPASS_REQUIRE=force`` makes ssh-keygen use it without a
    TTY. Caller must not put the passphrase in command argv.
    """
    td = tempfile.mkdtemp(prefix="porch-askpass-")
    phrase_path = Path(td) / "phrase"
    ask_path = Path(td) / "askpass"
    try:
        pfd = os.open(
            phrase_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
            0o600,
        )
        try:
            _write_all(pfd, passphrase.encode("utf-8"))
        finally:
            os.close(pfd)
        # Absolute path, shell-quoted — secret is NOT in the script text.
        ask_path.write_text(
            "#!/bin/sh\nexec cat -- "
            + shlex.quote(str(phrase_path))
            + "\n",
            encoding="utf-8",
        )
        os.chmod(ask_path, 0o700)
        env = dict(os.environ)
        env["SSH_ASKPASS"] = str(ask_path)
        env["SSH_ASKPASS_REQUIRE"] = "force"
        env.setdefault("DISPLAY", ":0")
        # Never export the passphrase itself.
        yield env
    finally:
        for path in (phrase_path, ask_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            os.rmdir(td)
        except OSError:
            pass


def _pub_core_from_text(pub_text: str) -> str:
    parts = pub_text.strip().split()
    if len(parts) < 2 or not parts[0].startswith("ssh-"):
        raise InitError("public key material is malformed — refuse")
    return f"{parts[0]} {parts[1]}"


def _pub_matches_private_bytes(
    key_bytes: bytes, pub_core: str, *, passphrase: str = ""
) -> bool:
    """Prove private bytes + public core match via ``ssh-keygen -y`` on a copy.

    The 0600 copy and its removal share one ``TemporaryDirectory`` lifetime, so
    no early return can skip the cleanup. A cleanup failure raises instead of
    being swallowed: a stranded private key is worse than a failed init.
    """
    result = None
    tmp_dir = tempfile.TemporaryDirectory(
        prefix="porch-keycopy-", ignore_cleanup_errors=False
    )
    try:
        try:
            td = Path(tmp_dir.name)
            os.chmod(td, 0o700)
            tmp_key = td / "material"
            fd = os.open(
                tmp_key,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                0o600,
            )
            try:
                _write_all(fd, key_bytes)
                os.fsync(fd)
            finally:
                os.close(fd)
            if passphrase == "":
                result = subprocess.run(
                    ["ssh-keygen", "-y", "-f", str(tmp_key), "-P", ""],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            else:
                with _ssh_askpass_env(passphrase) as env:
                    result = subprocess.run(
                        ["ssh-keygen", "-y", "-f", str(tmp_key)],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        env=env,
                        stdin=subprocess.DEVNULL,
                    )
        except (OSError, subprocess.TimeoutExpired, InitError):
            result = None
    finally:
        try:
            tmp_dir.cleanup()
        except OSError as exc:
            raise InitError(
                f"cannot remove the temporary private key copy at "
                f"{tmp_dir.name}: {exc} — remove it by hand",
                exit_code=4,
            ) from exc
    if result is None or result.returncode != 0:
        return False
    derived = (result.stdout or "").strip()
    try:
        return _pub_core_from_text(derived) == pub_core
    except InitError:
        return False


def _prompt_passphrase_for_adoption() -> str:
    import getpass

    try:
        return getpass.getpass(
            "existing encrypted key passphrase (for adoption): "
        )
    except (EOFError, KeyboardInterrupt) as exc:
        raise InitError("passphrase prompt cancelled") from exc


def _install_create_only(
    src: Path, dest: Path, *, mode: int, created: list[Path]
) -> None:
    """Copy src → dest via O_EXCL create-only (no replace / no follow).

    ``dest`` joins ``created`` the instant O_EXCL succeeds, before any write:
    a partial write leaves a real file at a trust path, and only the outer
    rollback may decide its fate.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    data = _read_regular_nofollow(src, limit=_MAX_KEY_BYTES, label="key material")
    try:
        fd = os.open(
            dest,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            mode,
        )
    except FileExistsError as exc:
        raise InitError(
            f"refusing to overwrite existing path at {dest} "
            "(ssh-keygen overwrite prompt never defines policy)"
        ) from exc
    except OSError as exc:
        raise InitError(f"cannot create {dest}: {exc}") from exc
    created.append(dest)
    try:
        try:
            _write_all(fd, data)
            os.fsync(fd)
            os.fchmod(fd, mode)
        except OSError as exc:
            raise InitError(f"cannot write {dest}: {exc}") from exc
    finally:
        os.close(fd)


def _adopt_or_refuse_existing_keypair(
    config: PorchConfig, *, interactive: bool
) -> str:
    """Adopt only a policy-matching regular no-follow pair; return pub core."""
    key = config.key_file
    pub = Path(str(key) + ".pub")
    try:
        held_key = _read_regular_held(
            key, limit=_MAX_KEY_BYTES, label="private key"
        )
        pub_bytes = _read_regular_nofollow(
            pub, limit=_MAX_PUB_BYTES, label="public key"
        )
    except InitError:
        raise
    key_bytes = held_key.data
    if not key_bytes:
        raise InitError(
            f"existing private key at {key} is empty — refuse (kept as-is)"
        )
    # Mode comes from the same fd the bytes came from. Re-stating the pathname
    # here would adopt a 0600 decoy that became the 0644 key we just read.
    mode = stat.S_IMODE(held_key.st.st_mode)
    if mode != 0o600:
        raise InitError(
            f"existing key at {key} has mode {oct(mode)}, want 0600 — "
            "refusing to adopt (kept as-is)"
        )
    try:
        pub_text = pub_bytes.decode("utf-8")
        pub_core = _pub_core_from_text(pub_text)
    except (UnicodeDecodeError, InitError) as exc:
        raise InitError(
            f"public key at {pub} is malformed — refuse (kept as-is)"
        ) from exc
    if _pub_matches_private_bytes(key_bytes, pub_core, passphrase=""):
        return pub_core
    if interactive and sys.stdin.isatty():
        passphrase = _prompt_passphrase_for_adoption()
        if _pub_matches_private_bytes(key_bytes, pub_core, passphrase=passphrase):
            return pub_core
    raise InitError(
        f"existing key pair at {key} does not match (ssh-keygen -y) — "
        "refuse (kept as-is); if the key is encrypted, re-run interactively "
        "to adopt it"
    )


def _ensure_keypair(
    config: PorchConfig, *, created: list[Path], interactive: bool
) -> str:
    """Ensure keypair exists; return validated public key core for signers."""
    key = config.key_file
    pub = Path(str(key) + ".pub")
    key_here = key.exists() or key.is_symlink()
    pub_here = pub.exists() or pub.is_symlink()
    if key_here or pub_here:
        if key_here and pub_here:
            return _adopt_or_refuse_existing_keypair(
                config, interactive=interactive
            )
        raise InitError(
            f"key material partially present at {key} / {pub} — refuse "
            "(ssh-keygen overwrite prompt never defines policy; kept as-is)"
        )
    passphrase = ""
    if interactive and sys.stdin.isatty():
        import getpass

        try:
            passphrase = getpass.getpass("key passphrase (empty allowed): ")
        except (EOFError, KeyboardInterrupt) as exc:
            raise InitError("passphrase prompt cancelled") from exc

    td = tempfile.mkdtemp(prefix="porch-keygen-")
    os.chmod(td, 0o700)
    tmp_key = Path(td) / "key"
    tmp_pub = Path(str(tmp_key) + ".pub")
    cmd = [
        "ssh-keygen",
        "-t",
        "ed25519",
        "-f",
        str(tmp_key),
        "-C",
        config.principal,
        "-q",
    ]
    try:
        try:
            if passphrase == "":
                result = subprocess.run(
                    [*cmd, "-N", ""],
                    check=False,
                    capture_output=True,
                )
            else:
                with _ssh_askpass_env(passphrase) as env:
                    result = subprocess.run(
                        cmd,
                        check=False,
                        capture_output=True,
                        env=env,
                        stdin=subprocess.DEVNULL,
                    )
        except FileNotFoundError as exc:
            raise InitError("ssh-keygen missing", exit_code=4) from exc
        except OSError as exc:
            raise InitError(f"ssh-keygen failed: {exc}", exit_code=4) from exc
        if result.returncode != 0:
            raise InitError("ssh-keygen failed", exit_code=4)
        if not _is_regular_nofollow(tmp_key) or not _is_regular_nofollow(tmp_pub):
            raise InitError("ssh-keygen produced non-regular key material")
        if os.lstat(tmp_pub).st_size > _MAX_PUB_BYTES:
            raise InitError("ssh-keygen produced oversized public key")
        pub_bytes = _read_regular_nofollow(
            tmp_pub, limit=_MAX_PUB_BYTES, label="public key"
        )
        pub_core = _pub_core_from_text(pub_bytes.decode("utf-8"))
        # Install create-only to final paths — planted destination refuses.
        # No local cleanup: _rollback_init owns every final-path unlink so a
        # failed cleanup is reported instead of silently swallowed here.
        _install_create_only(tmp_key, key, mode=0o600, created=created)
        _install_create_only(tmp_pub, pub, mode=0o644, created=created)
        return pub_core
    finally:
        for path in (tmp_key, tmp_pub):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            os.rmdir(td)
        except OSError:
            pass


def _match_pattern(pattern: str, text: str) -> bool:
    """OpenSSH ``match_pattern``: ``*`` matches any run, ``?`` exactly one char.

    Iterative backtracking rather than a translated regex — operator-supplied
    patterns must not reach a regex engine.
    """
    p = t = 0
    star = -1
    star_t = 0
    while t < len(text):
        if p < len(pattern) and pattern[p] == "*":
            star = p
            p += 1
            star_t = t
        elif p < len(pattern) and (pattern[p] == "?" or pattern[p] == text[t]):
            p += 1
            t += 1
        elif star >= 0:
            p = star + 1
            star_t += 1
            t = star_t
        else:
            return False
    while p < len(pattern) and pattern[p] == "*":
        p += 1
    return p == len(pattern)


def _match_pattern_list(pattern_list: str, text: str) -> bool:
    """OpenSSH ``match_pattern_list`` over a comma-separated list.

    A ``!``-negated subpattern that matches is a definitive NO for the whole
    list (that is how OpenSSH lets an operator carve one principal out), so
    ``!mara@porch,*`` does not grant mara. Case-sensitive, matching sshsig's
    ``match_principals_option`` call with ``dolower`` unset.
    """
    got_positive = False
    for sub in pattern_list.split(","):
        negated = sub.startswith("!")
        pattern = sub[1:] if negated else sub
        if not pattern:
            continue
        if _match_pattern(pattern, text):
            if negated:
                return False
            got_positive = True
    return got_positive


def _signers_line(config: PorchConfig, *, pub_core: str) -> str:
    parts = pub_core.split()
    if len(parts) < 2:
        raise InitError("public key core is malformed")
    keytype, keydata = parts[0], parts[1]
    return (
        f'{config.principal} namespaces="{config.signing_namespace}" '
        f"{keytype} {keydata}\n"
    )


def _append_allowed_signers(
    config: PorchConfig,
    *,
    created: list[Path],
    restore: list[tuple[Path, bytes, int]],
    pub_core: str,
    from_legacy: bool = False,
) -> None:
    path = config.allowed_signers
    line = _signers_line(config, pub_core=pub_core)
    line_bytes = line.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    newly_created = False
    fd = -1
    try:
        try:
            fd = os.open(
                path,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
            )
            newly_created = True
            # Track ownership immediately after O_EXCL — a later write/fsync
            # failure must still roll the orphan back.
            created.append(path)
        except FileExistsError:
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            newly_created = False
        # flock FIRST, then fstat/size/seek/read — a concurrent writer must
        # not append under us between size capture and the exclusive lock.
        fcntl.flock(fd, fcntl.LOCK_EX)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise InitError(
                "allowed_signers must be a regular file (symlink/FIFO refused)"
            )
        if st.st_size > _MAX_SIGNERS_BYTES:
            raise InitError(
                f"allowed_signers exceeds {_MAX_SIGNERS_BYTES} bytes — refuse"
            )
        os.lseek(fd, 0, os.SEEK_SET)
        original = _read_fd_to_eof_bounded(
            fd, limit=_MAX_SIGNERS_BYTES, label="allowed_signers"
        )
        try:
            existing = original.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise InitError(
                "allowed_signers is not valid UTF-8 — refuse"
            ) from exc
        # Scan EVERY principal line before deciding (no early return).
        exact_matches = 0
        for eline in existing.splitlines():
            if eline.startswith(config.principal + " ") or eline.startswith(
                config.principal + "\t"
            ):
                if eline + "\n" == line or eline == line.rstrip("\n"):
                    exact_matches += 1
                    continue
                raise InitError(
                    f"allowed_signers already has a different line for "
                    f"{config.principal} — refuse rotation (kept as-is)"
                )
            # ssh reads the first field as a PATTERNS list, so `*` or
            # `mara@porch,other` already authorizes our principal with someone
            # else's key. Appending our line would leave two live answers.
            stripped = eline.strip()
            if not stripped or stripped.startswith("#"):
                continue
            patterns = stripped.split()[0]
            if _match_pattern_list(patterns, config.principal):
                raise InitError(
                    f"allowed_signers has a conflicting pattern-list line "
                    f"({patterns!r}) that already matches {config.principal} "
                    "— refuse (kept as-is)"
                )
        if exact_matches > 1:
            raise InitError(
                f"allowed_signers has duplicate lines for {config.principal} "
                "— refuse (kept as-is)"
            )
        mode = stat.S_IMODE(st.st_mode)
        if exact_matches == 1:
            # Idempotent: require not group/world writable. New/generic runs
            # tighten to 0600; --from-legacy leaves legacy 0644 untouched.
            if mode & 0o022:
                raise InitError(
                    f"allowed_signers at {path} is group/world writable "
                    f"(mode {oct(mode)}) — refuse (kept as-is)"
                )
            if not from_legacy and mode != 0o600:
                # Mode-only mutation still needs rollback bookkeeping before
                # fchmod — a later config-commit failure must undo 0644→0600.
                restore.append((path, original, mode))
                os.fchmod(fd, 0o600)
            return
        # Pre-existing file: record rollback BEFORE any mutating write so a
        # partial os.write / fsync / fchmod failure can restore the original.
        # Mode travels with the bytes — the fchmod below is itself a mutation.
        if not newly_created:
            restore.append((path, original, mode))
        os.lseek(fd, 0, os.SEEK_END)
        _write_all(fd, line_bytes)
        os.fsync(fd)
        os.fchmod(fd, 0o600)
    except OSError as exc:
        raise InitError(f"cannot open/update allowed_signers: {exc}") from exc
    finally:
        if fd >= 0:
            os.close(fd)


def _restore_signers(path: Path, original: bytes, mode: int) -> None:
    """Rewrite signers under lock: open no-trunc → flock → ftruncate → write.

    Restores ``mode`` under the same held lock, because the append path
    tightens a legacy 0644 trust file to 0600 — bytes-only rollback would
    leave the operator's file silently re-permissioned.

    Raises InitError on any failure — callers collect compound rollback errors.
    """
    fd = -1
    try:
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        if original:
            _write_all(fd, original)
        os.fsync(fd)
        os.fchmod(fd, mode)
    except OSError as exc:
        raise InitError(
            f"failed to restore allowed_signers at {path}: {exc}"
        ) from exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError as exc:
                raise InitError(
                    f"failed to close allowed_signers at {path} after restore: {exc}"
                ) from exc


def _rollback_init(
    *,
    restore: list[tuple[Path, bytes, int]],
    created: list[Path],
    cause: BaseException,
) -> None:
    """Attempt every reverse-order rollback; raise compound InitError on retain."""
    failures: list[str] = []
    for path, original, mode in reversed(restore):
        try:
            _restore_signers(path, original, mode)
        except Exception as exc:  # noqa: BLE001 — collect all failures
            failures.append(f"{path} (restore failed: {exc})")
    for path in reversed(created):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            failures.append(f"{path} (cleanup failed: {exc})")
    if failures:
        raise InitError(
            "rollback incomplete — retained/mutated paths: "
            + "; ".join(failures)
            + f" (caused by: {cause})"
        ) from cause


def _configs_resolve_identical(a: PorchConfig, b: PorchConfig) -> bool:
    """Post-derivation comparison across every resolved identity field."""
    fields = (
        "owner_room",
        "owner_room_dir",
        "mail_root",
        "sidecar_dir",
        "allowed_signers",
        "key_file",
        "signing_namespace",
        "principal",
        "marker",
        "label",
        "initial_channel",
        "owner_accent",
    )
    return all(getattr(a, name) == getattr(b, name) for name in fields)


def _prompt(prompt: str, *, default: str | None, input_fn: Callable[[str], str]) -> str:
    suffix = f" [{default}]" if default else ""
    raw = input_fn(f"{prompt}{suffix}: ").strip()
    if not raw and default is not None:
        return default
    return raw


def _collect_config(
    *,
    from_legacy: bool,
    home: Path,
    owner_room: str | None,
    owner_room_dir: Path | None,
    mail_root: Path | None,
    marker: str | None,
    label: str | None,
    initial_channel: str | None,
    sidecar_dir: Path | None,
    allowed_signers: Path | None,
    key_file: Path | None,
    signing_namespace: str | None,
    principal: str | None,
    input_fn: Callable[[str], str] | None,
    interactive: bool,
    env: Mapping[str, str] | None,
) -> PorchConfig:
    ambient = env if env is not None else os.environ
    if from_legacy:
        vals = legacy_hardcoded_values(home=home)
        room_dir = Path(vals["owner_room_dir"])
        if not room_dir.is_dir():
            raise InitError(
                f"--from-legacy requires {room_dir} to exist "
                "(reads legacy paths; never writes through them)"
            )
        mail = resolve_mail_root(mail_root, env=ambient)
        return build_config(
            owner_room=vals["owner_room"],
            owner_room_dir=room_dir,
            mail_root=mail,
            marker=vals["marker"],
            label=vals["label"],
            initial_channel=vals["initial_channel"],
            env=ambient,
            explicit_fields=frozenset(
                {"mail_root", "marker", "label", "initial_channel"}
            ),
        )

    ask = interactive and input_fn is not None
    if owner_room is None and ask:
        owner_room = _prompt("owner_room", default=None, input_fn=input_fn)
    if owner_room_dir is None and ask:
        raw = _prompt("owner_room_dir (absolute)", default=None, input_fn=input_fn)
        owner_room_dir = Path(raw) if raw else None
    if not owner_room or owner_room_dir is None:
        raise InitError(
            "owner_room and owner_room_dir are required "
            "(pass flags, or run interactively on a TTY)"
        )
    owner_room_dir = Path(owner_room_dir)
    if ask:
        if marker is None:
            marker = (
                _prompt("marker", default=DEFAULT_MARKER, input_fn=input_fn) or None
            )
        if label is None:
            label = (
                _prompt(
                    "label",
                    default=default_label_for(owner_room),
                    input_fn=input_fn,
                )
                or None
            )
        if mail_root is None:
            default_mail = str(resolve_mail_root(None, env=ambient))
            raw = _prompt("mail_root", default=default_mail, input_fn=input_fn)
            mail_root = Path(raw) if raw else None
        if initial_channel is None:
            initial_channel = (
                _prompt("initial_channel", default="commons", input_fn=input_fn)
                or None
            )

    # Persist the resolved mail_root into the written config (B0):
    # explicit flag > ambient POST_MAIL_ROOT > default.
    resolved_mail = resolve_mail_root(mail_root, env=ambient)
    explicit: set[str] = {"mail_root"}
    kwargs: dict = {
        "owner_room": owner_room,
        "owner_room_dir": owner_room_dir,
        "mail_root": resolved_mail,
        "env": ambient,
    }
    if marker is not None:
        kwargs["marker"] = marker
        explicit.add("marker")
    if label is not None:
        kwargs["label"] = label
        explicit.add("label")
    if initial_channel is not None:
        kwargs["initial_channel"] = initial_channel
        explicit.add("initial_channel")
    if sidecar_dir is not None:
        kwargs["sidecar_dir"] = sidecar_dir
        explicit.add("sidecar_dir")
    if allowed_signers is not None:
        kwargs["allowed_signers"] = allowed_signers
        explicit.add("allowed_signers")
    if key_file is not None:
        kwargs["key_file"] = key_file
        explicit.add("key_file")
    if signing_namespace is not None:
        kwargs["signing_namespace"] = signing_namespace
        explicit.add("signing_namespace")
    if principal is not None:
        kwargs["principal"] = principal
        explicit.add("principal")
    kwargs["explicit_fields"] = frozenset(explicit)
    return build_config(**kwargs)


def run_init(
    *,
    from_legacy: bool = False,
    config_path: Path | None = None,
    home: Path | None = None,
    owner_room: str | None = None,
    owner_room_dir: Path | str | None = None,
    mail_root: Path | str | None = None,
    marker: str | None = None,
    label: str | None = None,
    initial_channel: str | None = None,
    sidecar_dir: Path | str | None = None,
    allowed_signers: Path | str | None = None,
    key_file: Path | str | None = None,
    signing_namespace: str | None = None,
    principal: str | None = None,
    input_fn: Callable[[str], str] | None = None,
    interactive: bool | None = None,
    env: dict[str, str] | None = None,
) -> int:
    config_path = config_path or CONFIG_PATH
    home = home or Path.home()
    if interactive is None:
        interactive = sys.stdin.isatty() and input_fn is None
    if interactive and input_fn is None:
        input_fn = input

    room_dir_path = Path(owner_room_dir) if owner_room_dir is not None else None
    mail_path = Path(mail_root) if mail_root is not None else None
    sidecar_path = Path(sidecar_dir) if sidecar_dir is not None else None
    signers_path = Path(allowed_signers) if allowed_signers is not None else None
    key_path = Path(key_file) if key_file is not None else None

    cfg = _collect_config(
        from_legacy=from_legacy,
        home=home,
        owner_room=owner_room,
        owner_room_dir=room_dir_path,
        mail_root=mail_path,
        marker=marker,
        label=label,
        initial_channel=initial_channel,
        sidecar_dir=sidecar_path,
        allowed_signers=signers_path,
        key_file=key_path,
        signing_namespace=signing_namespace,
        principal=principal,
        input_fn=input_fn,
        interactive=bool(interactive),
        env=env,
    )

    # FIRST preflight: post owner show (B0 §3 onboarding seam).
    try:
        post_owner = fetch_owner_show(cfg)
    except OwnerShowError as exc:
        raise InitError(str(exc)) from exc
    mismatches = owner_field_mismatches(cfg, post_owner)
    if mismatches:
        raise InitError(
            "post owner fields disagree with porch config — refuse before "
            f"mutation: {'; '.join(mismatches)}"
        )

    # Second preflight: acting-room cwd resolver BEFORE any mutation.
    try:
        assert_acting_room(cfg)
    except RoomInvariantError as exc:
        raise InitError(str(exc)) from exc

    # Existing config handling (full resolve-identical idempotence).
    if config_path.exists() or config_path.is_symlink():
        if config_path.is_symlink():
            raise InitError(f"refusing symlink at config path {config_path}")
        try:
            existing_bytes = _read_regular_nofollow(
                config_path, limit=_MAX_CONFIG_BYTES, label="config"
            )
            existing = load_config_bytes(
                existing_bytes, env=env if env is not None else {}
            )
        except InitError:
            raise
        except ConfigError as exc:
            raise InitError(f"existing config is malformed: {exc}") from exc
        if _configs_resolve_identical(existing, cfg):
            print(f"porch init: config already present and identical at {config_path}")
            return 0
        raise InitError(
            f"config already exists at {config_path} with different values — refuse"
        )

    created: list[Path] = []
    restore: list[tuple[Path, bytes, int]] = []
    try:
        pub_core = _ensure_keypair(
            cfg, created=created, interactive=bool(interactive)
        )
        _append_allowed_signers(
            cfg,
            created=created,
            restore=restore,
            pub_core=pub_core,
            from_legacy=from_legacy,
        )
        _write_config_atomic(cfg, config_path)
    except Exception as exc:
        _rollback_init(restore=restore, created=created, cause=exc)
        raise

    print(f"porch init: wrote {config_path}")
    print(f"  owner_room     {cfg.owner_room}")
    print(f"  owner_room_dir {cfg.owner_room_dir}")
    print(f"  mail_root      {cfg.mail_root}")
    print(f"  key_file       {cfg.key_file}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="porch init")
    parser.add_argument(
        "--from-legacy",
        action="store_true",
        help="write config from legacy compatibility values",
    )
    parser.add_argument("--config", default=None, help="alternate config path")
    parser.add_argument("--owner-room", default=None)
    parser.add_argument("--owner-room-dir", default=None)
    parser.add_argument("--mail-root", default=None)
    parser.add_argument("--marker", default=None)
    parser.add_argument("--label", default=None)
    parser.add_argument("--initial-channel", default=None)
    parser.add_argument("--sidecar-dir", default=None)
    parser.add_argument("--allowed-signers", default=None)
    parser.add_argument("--key-file", default=None)
    parser.add_argument("--signing-namespace", default=None)
    parser.add_argument("--principal", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    require_macos()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run_init(
            from_legacy=args.from_legacy,
            config_path=Path(args.config) if args.config else None,
            owner_room=args.owner_room,
            owner_room_dir=args.owner_room_dir,
            mail_root=args.mail_root,
            marker=args.marker,
            label=args.label,
            initial_channel=args.initial_channel,
            sidecar_dir=args.sidecar_dir,
            allowed_signers=args.allowed_signers,
            key_file=args.key_file,
            signing_namespace=args.signing_namespace,
            principal=args.principal,
        )
    except InitError as exc:
        print(f"porch init: {exc}", file=sys.stderr)
        return exc.exit_code
    except ConfigError as exc:
        print(f"porch init: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
