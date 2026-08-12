"""porch init mutation fixtures (B0 §3) — no $HOME writes."""

from __future__ import annotations

import fcntl
import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

from helpers import make_porch_config
from porch3.config import emit_toml, load_config
from porch3.initcli import InitError, run_init


def _owner_payload(cfg) -> dict:
    """Flat owner mapping as returned by ``fetch_owner_show`` after A0b parse."""
    return {
        "room": cfg.owner_room,
        "sidecar_dir": str(cfg.sidecar_dir),
        "allowed_signers": str(cfg.allowed_signers),
        "principal": cfg.principal,
        "namespace": cfg.signing_namespace,
        "marker": cfg.marker,
        "label": cfg.label,
    }


@pytest.fixture
def init_env(tmp_path, monkeypatch):
    """Synthetic owner tree under tmp_path; mock post owner show."""
    room = tmp_path / "mara-room"
    room.mkdir()
    mail = tmp_path / "mail"
    mail.mkdir()
    conf_dir = tmp_path / "cfg"
    conf_dir.mkdir()
    conf = conf_dir / "config.toml"

    # Build the would-be config to know derived paths for the mock payload.
    from porch3.config import build_config

    cfg = build_config(
        owner_room="mara",
        owner_room_dir=room,
        mail_root=mail,
        marker="🦊",
        label="Mara",
        env={},
        explicit_fields=frozenset({"mail_root", "marker", "label"}),
    )

    def fake_fetch(config):
        return _owner_payload(config)

    monkeypatch.setattr("porch3.initcli.fetch_owner_show", fake_fetch)
    monkeypatch.setattr("porch3.initcli.assert_acting_room", lambda config: None)
    return {
        "room": room,
        "mail": mail,
        "conf": conf,
        "cfg": cfg,
        "tmp": tmp_path,
    }


def _run(init_env, **extra):
    kwargs = dict(
        config_path=init_env["conf"],
        owner_room="mara",
        owner_room_dir=init_env["room"],
        mail_root=init_env["mail"],
        marker="🦊",
        label="Mara",
        interactive=False,
    )
    kwargs.update(extra)
    return run_init(**kwargs)


def test_happy_path_creates_keypair_signers_config(init_env):
    assert _run(init_env) == 0
    conf = init_env["conf"]
    assert conf.is_file()
    assert stat.S_IMODE(conf.stat().st_mode) == 0o600
    loaded = load_config(conf, env={})
    assert loaded.owner_room == "mara"
    assert loaded.marker == "🦊"
    key = loaded.key_file
    pub = Path(str(key) + ".pub")
    assert key.is_file() and pub.is_file()
    assert stat.S_IMODE(key.stat().st_mode) == 0o600
    assert loaded.allowed_signers.is_file()
    line = loaded.allowed_signers.read_text()
    assert loaded.principal in line
    assert loaded.signing_namespace in line


def test_symlink_at_config_refused(init_env):
    target = init_env["tmp"] / "elsewhere.toml"
    target.write_text("x")
    init_env["conf"].symlink_to(target)
    with pytest.raises(InitError, match="symlink"):
        _run(init_env)


def test_existing_different_config_refused(init_env):
    other = make_porch_config(init_env["tmp"] / "other", owner_room="river", marker="🐉")
    init_env["conf"].write_text(emit_toml(other))
    with pytest.raises(InitError, match="different"):
        _run(init_env)


def test_existing_identical_is_idempotent(init_env):
    assert _run(init_env) == 0
    # Second run must succeed without rewriting / erroring.
    assert _run(init_env) == 0


def test_idempotence_compares_full_resolved_fields(init_env):
    assert _run(init_env) == 0
    # Same required fields but different derived principal via explicit override
    # would disagree — prove we don't only compare the subset.
    with pytest.raises(InitError, match="different"):
        run_init(
            config_path=init_env["conf"],
            owner_room="mara",
            owner_room_dir=init_env["room"],
            mail_root=init_env["mail"],
            marker="🦊",
            label="Mara",
            principal="other@porch",
            interactive=False,
        )


def test_empty_preexisting_allowed_signers_restored_byte_identical_on_rollback(
    init_env, monkeypatch
):
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    original = b"# keep me\n"
    signers.write_bytes(original)

    def boom(*a, **k):
        raise InitError("forced failure after signers")

    monkeypatch.setattr("porch3.initcli._write_config_atomic", boom)
    with pytest.raises(InitError, match="forced failure"):
        _run(init_env)
    assert signers.exists()
    assert signers.read_bytes() == original


def test_differing_signers_line_refused(init_env):
    assert _run(init_env) == 0
    # Remove config so init retries, but leave a conflicting signers line.
    init_env["conf"].unlink()
    signers = init_env["cfg"].allowed_signers
    signers.write_text(f"{init_env['cfg'].principal} namespaces=\"wrong\" ssh-ed25519 AAAA\n")
    # Keypair still present — will be adopted if policy-ok; signers conflict refuses.
    with pytest.raises(InitError, match="different line"):
        _run(init_env)


def test_partial_ssh_keygen_cleaned(init_env, monkeypatch):
    cfg = init_env["cfg"]

    def fake_run(cmd, **kwargs):
        # Pretend ssh-keygen wrote a private key then failed.
        key = Path(cmd[cmd.index("-f") + 1])
        key.write_text("partial-private")
        (Path(str(key) + ".pub")).write_text("ssh-ed25519 AAAA comment")

        class R:
            returncode = 1
            stdout = b""
            stderr = b"fail"

        return R()

    monkeypatch.setattr("porch3.initcli.subprocess.run", fake_run)
    with pytest.raises(InitError, match="ssh-keygen failed"):
        _run(init_env)
    assert not cfg.key_file.exists()
    assert not Path(str(cfg.key_file) + ".pub").exists()


def test_existing_key_adopted_when_policy_ok(init_env):
    assert _run(init_env) == 0
    key = init_env["cfg"].key_file
    pub = Path(str(key) + ".pub")
    init_env["conf"].unlink()
    # Leave key+signers; re-run should adopt and write config.
    assert _run(init_env) == 0
    assert key.exists() and pub.exists()


def test_existing_key_symlink_refused(init_env):
    cfg = init_env["cfg"]
    cfg.key_file.parent.mkdir(parents=True, exist_ok=True)
    real = init_env["tmp"] / "realkey"
    real.write_text("x")
    cfg.key_file.symlink_to(real)
    Path(str(cfg.key_file) + ".pub").write_text("ssh-ed25519 AAAA c\n")
    with pytest.raises(InitError, match="regular|unreadable|non-follow"):
        _run(init_env)


def test_destination_created_mid_commit_race_different(init_env, monkeypatch):
    real_link = os.link

    def raced_link(src, dest):
        Path(dest).write_text("planted")
        return real_link(src, dest)

    monkeypatch.setattr("porch3.initcli.os.link", raced_link)
    with pytest.raises(InitError, match="malformed|different|already exists"):
        _run(init_env)


def test_destination_created_mid_commit_race_identical(init_env, monkeypatch):
    from porch3.config import emit_toml
    from porch3.initcli import _collect_config

    real_link = os.link

    def raced_link(src, dest):
        # Plant byte-identical content so create-only treats it as success.
        Path(dest).write_bytes(Path(src).read_bytes())
        raise FileExistsError(dest)

    monkeypatch.setattr("porch3.initcli.os.link", raced_link)
    assert _run(init_env) == 0
    assert init_env["conf"].is_file()


def test_destination_created_mid_commit_race_malformed(init_env, monkeypatch):
    real_link = os.link

    def raced_link(src, dest):
        Path(dest).write_text("not-toml{{{")
        raise FileExistsError(dest)

    monkeypatch.setattr("porch3.initcli.os.link", raced_link)
    with pytest.raises(InitError, match="malformed"):
        _run(init_env)


def test_acting_room_checked_before_mutation(init_env, monkeypatch):
    def boom(config):
        raise InitError("acting-room mismatch: wrong dir")

    # Replace the fixture no-op with a hard fail.
    monkeypatch.setattr("porch3.initcli.assert_acting_room", boom)

    def fail_if_called(*a, **k):
        raise AssertionError("keypair must not run before acting-room check")

    monkeypatch.setattr("porch3.initcli._ensure_keypair", fail_if_called)
    with pytest.raises(InitError, match="acting-room mismatch"):
        _run(init_env)
    assert not init_env["conf"].exists()
    assert not init_env["cfg"].key_file.exists()


def test_env_only_mail_root_persisted(init_env, monkeypatch):
    alt = init_env["tmp"] / "alt-mail"
    alt.mkdir()
    env = {**os.environ, "POST_MAIL_ROOT": str(alt)}
    code = run_init(
        config_path=init_env["conf"],
        owner_room="mara",
        owner_room_dir=init_env["room"],
        marker="🦊",
        label="Mara",
        interactive=False,
        env=env,
    )
    assert code == 0
    loaded = load_config(init_env["conf"], env={})
    assert loaded.mail_root == alt


def test_interactive_mail_root_default_reflects_env(init_env, monkeypatch):
    alt = init_env["tmp"] / "env-mail"
    alt.mkdir()
    env = {**os.environ, "POST_MAIL_ROOT": str(alt)}
    seen: list[str] = []

    def input_fn(prompt: str) -> str:
        seen.append(prompt)
        if "owner_room_dir" in prompt:
            return str(init_env["room"])
        if "owner_room" in prompt:
            return "mara"
        # Accept defaults for marker/label/mail_root/channel.
        return ""

    code = run_init(
        config_path=init_env["conf"],
        interactive=True,
        input_fn=input_fn,
        env=env,
    )
    assert code == 0
    mail_prompt = next(p for p in seen if p.startswith("mail_root"))
    assert str(alt) in mail_prompt
    loaded = load_config(init_env["conf"], env={})
    assert loaded.mail_root == alt
    assert loaded.marker == "🦊"  # DEFAULT_MARKER, not fox
    assert loaded.label == "Mara"  # default_label_for, not capitalize drift


def test_path_inputs_require_absolute(tmp_path):
    from porch3.config import ConfigError, build_config

    room = tmp_path / "room"
    room.mkdir()
    with pytest.raises(ConfigError, match="absolute"):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            sidecar_dir=Path("relative-sidecar"),
            env={},
        )
    with pytest.raises(ConfigError, match="absolute"):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            key_file=Path("relative-key"),
            env={},
        )


def test_encrypted_keypair_adopted_with_passphrase(init_env, monkeypatch):
    """Crash leftover encrypted key is adoptable when passphrase is prompted."""
    cfg = init_env["cfg"]
    key = cfg.key_file
    pub = Path(str(key) + ".pub")
    key.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-f",
            str(key),
            "-C",
            cfg.principal,
            "-N",
            "secret-pass",
            "-q",
        ],
        check=True,
        capture_output=True,
    )
    os.chmod(key, 0o600)
    # Signers empty pre-existing so append proceeds after adoption.
    monkeypatch.setattr(
        "porch3.initcli._prompt_passphrase_for_adoption", lambda: "secret-pass"
    )
    monkeypatch.setattr("porch3.initcli.sys.stdin.isatty", lambda: True)
    assert (
        run_init(
            config_path=init_env["conf"],
            owner_room="mara",
            owner_room_dir=init_env["room"],
            mail_root=init_env["mail"],
            marker="🦊",
            label="Mara",
            initial_channel="commons",
            interactive=True,
        )
        == 0
    )
    assert key.exists() and pub.exists()


def test_post_commit_temp_unlink_failure_does_not_rollback(init_env, monkeypatch):
    real_unlink = Path.unlink
    calls = {"n": 0}

    def flaky_unlink(self, *a, **k):
        # Fail the temp unlink after hardlink; leave config committed.
        name = self.name
        if name.startswith(".porch-config.") and name.endswith(".tmp"):
            calls["n"] += 1
            raise OSError("injected unlink failure")
        return real_unlink(self, *a, **k)

    monkeypatch.setattr(Path, "unlink", flaky_unlink)
    assert _run(init_env) == 0
    assert init_env["conf"].is_file()
    assert init_env["cfg"].key_file.is_file()
    assert calls["n"] >= 1


def test_allowed_signers_oversize_refused(init_env):
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    signers.write_bytes(b"x" * ((1 << 20) + 1))
    with pytest.raises(InitError, match="exceeds"):
        _run(init_env)


def test_alternate_config_parent_does_not_touch_global_config_dir(
    init_env, monkeypatch
):
    """Temp + mkdir only under the alternate --config parent."""
    calls: list[Path] = []
    real_mkdir = Path.mkdir

    def spy_mkdir(self, *a, **k):
        calls.append(self)
        return real_mkdir(self, *a, **k)

    monkeypatch.setattr(Path, "mkdir", spy_mkdir)
    assert _run(init_env) == 0
    home_config = Path.home() / ".config" / "porch"
    for path in calls:
        assert home_config not in path.parents and path != home_config, path


def test_interactive_prompts_collect_fields(init_env):
    answers = iter(
        [
            "mara",
            str(init_env["room"]),
            "🦊",
            "Mara",
            str(init_env["mail"]),
            "commons",
        ]
    )
    code = run_init(
        config_path=init_env["conf"],
        interactive=True,
        input_fn=lambda prompt: next(answers),
        env={},
    )
    assert code == 0
    loaded = load_config(init_env["conf"], env={})
    assert loaded.owner_room == "mara"
    assert loaded.marker == "🦊"


def test_owner_mismatch_refuses_before_mutation(init_env, monkeypatch):
    def bad_fetch(config):
        payload = _owner_payload(config)
        payload["label"] = "Nope"
        return payload

    monkeypatch.setattr("porch3.initcli.fetch_owner_show", bad_fetch)
    with pytest.raises(InitError, match="disagree"):
        _run(init_env)
    assert not init_env["conf"].exists()
    assert not init_env["cfg"].key_file.exists()


def test_passphrase_absent_from_ssh_keygen_argv_env(init_env, monkeypatch):
    """Nonempty passphrase must never appear in ssh-keygen argv or env."""
    secret = "never-in-argv-or-env-9f3a"
    captured: list[tuple[list, dict | None]] = []
    real_run = subprocess.run

    def spy_run(cmd, **kwargs):
        env = kwargs.get("env")
        captured.append((list(cmd), dict(env) if env is not None else None))
        # Prove secret absent before delegating.
        assert secret not in cmd
        assert all(secret not in str(c) for c in cmd)
        if env is not None:
            assert all(secret not in str(v) for v in env.values())
        return real_run(cmd, **kwargs)

    monkeypatch.setattr("porch3.initcli.subprocess.run", spy_run)
    monkeypatch.setattr("porch3.initcli.sys.stdin.isatty", lambda: True)
    import getpass as getpass_mod

    monkeypatch.setattr(getpass_mod, "getpass", lambda prompt="": secret)
    assert _run(init_env, interactive=True, initial_channel="commons") == 0
    # At least one ssh-keygen invocation happened without -N/-P secret.
    assert any("ssh-keygen" in c for c, _ in captured)
    for cmd, env in captured:
        joined = " ".join(str(x) for x in cmd)
        assert secret not in joined
        assert "-P" not in cmd or cmd[cmd.index("-P") + 1] == ""
        if "-N" in cmd:
            assert cmd[cmd.index("-N") + 1] == ""


def test_config_symlink_fifo_dir_refused_precheck_and_race(init_env, monkeypatch):
    conf = init_env["conf"]
    # Precheck: FIFO
    if hasattr(os, "mkfifo"):
        os.mkfifo(conf)
        with pytest.raises(InitError, match="regular|FIFO|unreadable|non-follow"):
            _run(init_env)
        conf.unlink()
    # Precheck: directory
    conf.mkdir()
    with pytest.raises(InitError, match="regular|directory|unreadable"):
        _run(init_env)
    conf.rmdir()
    # Mid-commit race: plant FIFO
    real_link = os.link

    def race_fifo(src, dest):
        if hasattr(os, "mkfifo"):
            os.mkfifo(dest)
        else:
            Path(dest).mkdir()
        raise FileExistsError(dest)

    monkeypatch.setattr("porch3.initcli.os.link", race_fifo)
    with pytest.raises(InitError, match="regular|FIFO|directory|unreadable|non-follow"):
        _run(init_env)
    # Cleanup planted nonregular if still present
    if conf.exists() or conf.is_symlink():
        if conf.is_dir() and not conf.is_symlink():
            conf.rmdir()
        else:
            conf.unlink()
    # Mid-commit race: plant symlink
    target = init_env["tmp"] / "elsewhere.toml"
    target.write_text('owner_room = "x"\n')

    def race_symlink(src, dest):
        Path(dest).symlink_to(target)
        raise FileExistsError(dest)

    monkeypatch.setattr("porch3.initcli.os.link", race_symlink)
    with pytest.raises(InitError, match="regular|unreadable|non-follow|symlink"):
        _run(init_env)


def test_raced_resolve_identical_byte_different_succeeds(init_env, monkeypatch):
    """Reordered/explicit-default TOML with same resolved config is idempotent."""
    from porch3.config import build_config, emit_toml

    cfg = build_config(
        owner_room="mara",
        owner_room_dir=init_env["room"],
        mail_root=init_env["mail"],
        marker="🦊",
        label="Mara",
        # Explicit defaults that emit.toml would omit when derived-only —
        # force a byte-different but resolve-identical document.
        signing_namespace="mara-porch",
        principal="mara@porch",
        env={},
        explicit_fields=frozenset(
            {"mail_root", "marker", "label", "signing_namespace", "principal"}
        ),
    )
    alt_bytes = emit_toml(cfg).encode("utf-8")

    def raced_link(src, dest):
        Path(dest).write_bytes(alt_bytes)
        raise FileExistsError(dest)

    monkeypatch.setattr("porch3.initcli.os.link", raced_link)
    assert _run(init_env) == 0


def test_raced_different_valid_refused(init_env, monkeypatch):
    other = make_porch_config(init_env["tmp"] / "other", owner_room="river", marker="🐉")
    planted = emit_toml(other).encode("utf-8")

    def raced_link(src, dest):
        Path(dest).write_bytes(planted)
        raise FileExistsError(dest)

    monkeypatch.setattr("porch3.initcli.os.link", raced_link)
    with pytest.raises(InitError, match="different"):
        _run(init_env)


def test_signers_flock_before_fstat(init_env, monkeypatch):
    """Deterministic two-fd: concurrent append while unlocked must not duplicate."""
    import threading
    import time

    from porch3.initcli import _append_allowed_signers, _pub_core_from_text

    assert _run(init_env) == 0
    # Reset: remove config so we can re-enter append; keep keypair; clear signers.
    init_env["conf"].unlink()
    signers = init_env["cfg"].allowed_signers
    original = signers.read_bytes()
    signers.write_bytes(b"")
    pub = Path(str(init_env["cfg"].key_file) + ".pub")
    pub_core = _pub_core_from_text(pub.read_text(encoding="utf-8"))

    order: list[str] = []
    real_flock = fcntl.flock
    real_fstat = os.fstat
    lock_held = threading.Event()
    release = threading.Event()

    def tracking_flock(fd, op):
        order.append("flock")
        return real_flock(fd, op)

    def tracking_fstat(fd):
        # Only count fstat after our open of the signers path — approximate by
        # recording every fstat once flock has been seen for this call path.
        order.append("fstat")
        return real_fstat(fd)

    # Hold an exclusive lock on a second fd until the appender's flock blocks,
    # then append a conflicting same-principal line and release — the appender
    # must see the post-lock size and refuse, not duplicate from a stale prefix.
    holder_fd = os.open(signers, os.O_RDWR)
    fcntl.flock(holder_fd, fcntl.LOCK_EX)
    lock_held.set()

    def adversary():
        lock_held.wait(2)
        time.sleep(0.05)
        # Append conflicting line under our lock, then release.
        os.lseek(holder_fd, 0, os.SEEK_END)
        os.write(
            holder_fd,
            f'{init_env["cfg"].principal} namespaces="other" ssh-ed25519 AAAA\n'.encode(),
        )
        os.fsync(holder_fd)
        fcntl.flock(holder_fd, fcntl.LOCK_UN)
        release.set()

    t = threading.Thread(target=adversary)
    t.start()
    monkeypatch.setattr("porch3.initcli.fcntl.flock", tracking_flock)
    monkeypatch.setattr("porch3.initcli.os.fstat", tracking_fstat)
    created: list = []
    restore: list = []
    with pytest.raises(InitError, match="different line"):
        _append_allowed_signers(
            init_env["cfg"],
            created=created,
            restore=restore,
            pub_core=pub_core,
        )
    t.join(timeout=5)
    os.close(holder_fd)
    # flock must precede fstat in the append path.
    assert order.index("flock") < order.index("fstat")
    text = signers.read_text()
    assert text.count(init_env["cfg"].principal) == 1
    _ = original


def test_restore_signers_flock_before_truncate(init_env, monkeypatch):
    calls: list[tuple] = []
    real_open = os.open
    real_flock = fcntl.flock
    real_ftruncate = os.ftruncate

    def spy_open(path, flags, *a, **k):
        calls.append(("open", flags))
        return real_open(path, flags, *a, **k)

    def spy_flock(fd, op):
        calls.append(("flock", op))
        return real_flock(fd, op)

    def spy_ftruncate(fd, size):
        calls.append(("ftruncate", size))
        return real_ftruncate(fd, size)

    monkeypatch.setattr("porch3.initcli.os.open", spy_open)
    monkeypatch.setattr("porch3.initcli.fcntl.flock", spy_flock)
    monkeypatch.setattr("porch3.initcli.os.ftruncate", spy_ftruncate)
    from porch3.initcli import _restore_signers

    path = init_env["tmp"] / "signers"
    path.write_bytes(b"old\n")
    _restore_signers(path, b"restored\n", 0o600)
    assert path.read_bytes() == b"restored\n"
    open_flags = next(c[1] for c in calls if c[0] == "open")
    assert not (open_flags & getattr(os, "O_TRUNC", 0))
    names = [c[0] for c in calls]
    assert names.index("flock") < names.index("ftruncate")


def test_signers_oexcl_tracked_before_write_failure(init_env, monkeypatch):
    """O_EXCL create must enter rollback tracking even if write/fsync fails."""
    real_write = os.write

    def boom_write(fd, data):
        raw = bytes(data)
        # Fail only the allowed_signers principal line — not key material installs.
        if b"namespaces=" in raw:
            raise OSError("injected write failure")
        return real_write(fd, data)

    monkeypatch.setattr("porch3.initcli.os.write", boom_write)
    with pytest.raises(InitError, match="cannot open/update|injected|short|rollback"):
        _run(init_env)
    signers = init_env["cfg"].allowed_signers
    assert not signers.exists()


def test_preexisting_signers_partial_write_restores_original(init_env, monkeypatch):
    """Item 4: restore bookkeeping before first write — partial write rolls back."""
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    original = b"# original\n"
    signers.write_bytes(original)

    real_write = os.write
    state = {"n": 0}

    def partial_then_fail(fd, data):
        raw = bytes(data)
        if b"namespaces=" in raw:
            state["n"] += 1
            if state["n"] == 1:
                # Real partial first write (5 bytes of the new line).
                return real_write(fd, raw[:5])
            raise OSError("injected second-write failure")
        return real_write(fd, data)

    monkeypatch.setattr("porch3.initcli.os.write", partial_then_fail)
    with pytest.raises(InitError):
        _run(init_env)
    assert signers.read_bytes() == original


def test_owner_show_first_emits_exact_init_command(init_env, monkeypatch):
    order: list[str] = []

    def boom_fetch(config):
        order.append("owner_show")
        from porch3.roomcheck import OwnerShowError, post_owner_init_command

        raise OwnerShowError(
            f"post owner state is 'legacy' (need configured) — "
            f"run `{post_owner_init_command(config)}` first"
        )

    def boom_room(config):
        order.append("acting_room")
        raise AssertionError("acting-room must not run before owner-show")

    monkeypatch.setattr("porch3.initcli.fetch_owner_show", boom_fetch)
    monkeypatch.setattr("porch3.initcli.assert_acting_room", boom_room)
    with pytest.raises(InitError, match=r"post owner init --room mara") as ei:
        _run(init_env)
    assert order == ["owner_show"]
    msg = str(ei.value)
    assert "--marker" not in msg  # default marker is omitted
    # label "Mara" equals default_label_for("mara") — omitted from exact cmd
    assert "--label" not in msg
    assert "post owner init --room mara" in msg


def test_post_owner_init_command_includes_nondefaults(tmp_path):
    from porch3.config import build_config
    from porch3.roomcheck import post_owner_init_command

    room = tmp_path / "room"
    room.mkdir()
    sc = tmp_path / "sidecar"
    sc.mkdir()
    mail = tmp_path / "alt root"
    mail.mkdir()
    cfg = build_config(
        owner_room="mara",
        owner_room_dir=room,
        mail_root=mail,
        marker="🐉",
        label="Custom",
        sidecar_dir=sc,
        allowed_signers=sc / "custom_signers",
        principal="mara@custom",
        signing_namespace="mara-custom",
        env={},
        explicit_fields=frozenset(
            {
                "mail_root",
                "marker",
                "label",
                "sidecar_dir",
                "allowed_signers",
                "principal",
                "signing_namespace",
            }
        ),
    )
    cmd = post_owner_init_command(cfg)
    assert cmd.startswith("env POST_MAIL_ROOT=")
    assert "alt root" in cmd or "alt\\ root" in cmd or "'/'" in cmd or "POST_MAIL_ROOT=" in cmd
    assert shlex_has_mail_root(cmd, mail)
    assert "post owner init --room mara" in cmd or "post owner init" in cmd
    assert "--marker" in cmd and "🐉" in cmd
    assert "--label Custom" in cmd or "--label 'Custom'" in cmd
    assert "--sidecar-dir" in cmd
    assert "--allowed-signers" in cmd
    assert "--principal" in cmd
    assert "--namespace" in cmd


def shlex_has_mail_root(cmd: str, mail: Path) -> bool:
    import shlex

    return shlex.quote(str(mail)) in cmd


def test_owner_show_suggests_explicit_mail_root_with_spaces(init_env, monkeypatch):
    """Suggestion must pin POST_MAIL_ROOT so alt roots cannot loop to default."""
    alt = init_env["tmp"] / "alt root"
    alt.mkdir()

    def boom_fetch(config):
        from porch3.roomcheck import OwnerShowError, post_owner_init_command

        raise OwnerShowError(
            f"post owner state is 'none' — run `{post_owner_init_command(config)}` first"
        )

    monkeypatch.setattr("porch3.initcli.fetch_owner_show", boom_fetch)
    with pytest.raises(InitError) as ei:
        _run(init_env, mail_root=alt)
    msg = str(ei.value)
    assert "POST_MAIL_ROOT=" in msg
    assert "alt root" in msg or shlex_has_mail_root(msg, alt)
    assert "post owner init" in msg


def test_doctor_throwaway_passphrase_not_in_argv(tmp_path, monkeypatch):
    """porchd doctor interactive fallback must not put -P <phrase> on argv."""
    import sys

    from porch3.initcli import _ssh_askpass_env
    from porchd import cli as porchd_cli

    cfg = make_porch_config(tmp_path, owner_room="mara")
    secret = "doctor-secret-not-argv"
    with _ssh_askpass_env(secret) as env:
        subprocess.run(
            [
                "ssh-keygen",
                "-t",
                "ed25519",
                "-f",
                str(cfg.key_file),
                "-C",
                cfg.principal,
                "-q",
            ],
            check=True,
            capture_output=True,
            env=env,
            stdin=subprocess.DEVNULL,
        )
    pub = Path(str(cfg.key_file) + ".pub")
    line = pub.read_text().strip().split()
    cfg.allowed_signers.parent.mkdir(parents=True, exist_ok=True)
    cfg.allowed_signers.write_text(
        f'{cfg.principal} namespaces="{cfg.signing_namespace}" {line[0]} {line[1]}\n'
    )
    captured: list[list] = []
    real_run = subprocess.run

    def spy(cmd, **kwargs):
        captured.append(list(cmd))
        assert all(secret not in str(c) for c in cmd)
        env = kwargs.get("env")
        if env is not None:
            assert all(secret not in str(v) for v in env.values())
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    import getpass as getpass_mod

    monkeypatch.setattr(getpass_mod, "getpass", lambda prompt="": secret)
    ok, detail = porchd_cli._throwaway_sign_verify(cfg, state_root=None)
    assert ok, detail
    assert any(cmd and cmd[0] == "ssh-keygen" for cmd in captured)
    for cmd in captured:
        if "-P" in cmd:
            assert cmd[cmd.index("-P") + 1] != secret


def test_signers_duplicate_principal_and_world_writable_refused(init_env):
    """Item 5: scan every line; refuse duplicates; refuse group/world writable."""
    assert _run(init_env) == 0
    init_env["conf"].unlink()
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    good = signers.read_text()
    attack = (
        good.rstrip("\n")
        + "\n"
        + f'{cfg.principal} namespaces="{cfg.signing_namespace}" ssh-ed25519 ATTACKER\n'
    )
    signers.write_text(attack)
    with pytest.raises(InitError, match="different line|duplicate"):
        _run(init_env)

    # Exact single line but mode 0666 must refuse.
    signers.write_text(good)
    os.chmod(signers, 0o666)
    with pytest.raises(InitError, match="group/world writable"):
        _run(init_env)
    assert stat.S_IMODE(signers.stat().st_mode) == 0o666


def test_from_legacy_exact_signers_leaves_0644(init_env, monkeypatch):
    """Item 5: --from-legacy must not chmod existing legacy 0644 trust file."""
    from porch3.config import legacy_hardcoded_values

    home = init_env["tmp"] / "home"
    vals = legacy_hardcoded_values(home=home)
    Path(vals["owner_room_dir"]).mkdir(parents=True)
    # Point legacy paths under our tmp home.
    monkeypatch.setattr(
        "porch3.initcli.legacy_hardcoded_values",
        lambda home=None: {
            **vals,
            "owner_room": "mara",
            "owner_room_dir": str(init_env["room"]),
            "marker": "🦊",
            "label": "Mara",
            "initial_channel": "commons",
        },
    )
    # Build keypair+signers first via normal init, then convert to legacy mode.
    assert _run(init_env) == 0
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    os.chmod(signers, 0o644)
    init_env["conf"].unlink()
    # from_legacy reuses same derived key/signers under mara room.
    assert (
        run_init(
            from_legacy=True,
            config_path=init_env["conf"],
            home=home,
            mail_root=init_env["mail"],
            interactive=False,
        )
        == 0
    )
    assert stat.S_IMODE(signers.stat().st_mode) == 0o644


def test_restore_failure_raises_compound_naming_path(init_env, monkeypatch):
    """Item 6: swallowed restore must become compound InitError naming retained path."""
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    original = b"# keep\n"
    signers.write_bytes(original)

    def boom_config(*a, **k):
        raise InitError("forced config failure")

    def boom_ftruncate(fd, size):
        raise OSError("injected ftruncate failure")

    monkeypatch.setattr("porch3.initcli._write_config_atomic", boom_config)
    monkeypatch.setattr("porch3.initcli.os.ftruncate", boom_ftruncate)
    with pytest.raises(InitError, match="rollback incomplete|retained") as ei:
        _run(init_env)
    msg = str(ei.value)
    assert str(signers) in msg
    # Appended trusted key remains because restore failed — named in error.
    assert signers.exists()
    assert original != signers.read_bytes() or "restore failed" in msg


def test_planted_key_destination_before_keygen_refused(init_env, monkeypatch):
    """Item 8: planted final path immediately before install must refuse (no overwrite)."""
    cfg = init_env["cfg"]
    real_run = subprocess.run

    def plant_then_run(cmd, **kwargs):
        if cmd and cmd[0] == "ssh-keygen" and "-t" in cmd:
            # After temp keygen succeeds, plant the FINAL destination before install.
            result = real_run(cmd, **kwargs)
            cfg.key_file.parent.mkdir(parents=True, exist_ok=True)
            cfg.key_file.write_text("planted-private")
            Path(str(cfg.key_file) + ".pub").write_text("ssh-ed25519 PLANTED c\n")
            return result
        return real_run(cmd, **kwargs)

    monkeypatch.setattr("porch3.initcli.subprocess.run", plant_then_run)
    with pytest.raises(InitError, match="overwrite|refusing|existing path"):
        _run(init_env)
    # Planted material must not be treated as our created pair for cleanup of
    # unrelated files — but create-only refusal leaves planted as-is.
    assert cfg.key_file.read_text() == "planted-private"


def test_key_pub_swap_to_fifo_after_validation_no_hang(init_env, monkeypatch):
    """Item 8: pub swap to FIFO after held read must not follow/hang on reopen."""
    assert _run(init_env) == 0
    init_env["conf"].unlink()
    cfg = init_env["cfg"]
    pub = Path(str(cfg.key_file) + ".pub")
    # After successful adoption validation path would reopen — force swap mid-flight
    # by replacing pub with FIFO before a second run that rebuilds signers line.
    # Empty signers so append needs pub_core from adoption held bytes.
    good_signers = cfg.allowed_signers.read_bytes()
    cfg.allowed_signers.write_bytes(b"")
    real_read = None
    from porch3 import initcli as initcli_mod

    real_rr = initcli_mod._read_regular_nofollow
    state = {"n": 0}

    def swap_after_pub_read(path, *, limit, label):
        data = real_rr(path, limit=limit, label=label)
        state["n"] += 1
        if label == "public key" and state["n"] >= 1:
            # Swap pub to FIFO after held read — later reopen would hang without held bytes.
            if pub.exists() and not pub.is_fifo():
                pub.unlink()
                os.mkfifo(pub)
        return data

    monkeypatch.setattr(initcli_mod, "_read_regular_nofollow", swap_after_pub_read)
    # Adoption should succeed using held bytes; signers rewrite uses pub_core.
    assert _run(init_env) == 0
    # Signers restored with exact principal line from held pub_core.
    assert cfg.principal in cfg.allowed_signers.read_text()
    _ = good_signers
    _ = real_read


def test_temp_key_copy_not_stranded_when_the_write_fails(tmp_path, monkeypatch):
    """Item 7: a failure mid-helper leaves no porch-keycopy-* dir behind."""
    import tempfile as tempfile_mod

    from porch3.initcli import _pub_matches_private_bytes

    sandbox = tmp_path / "tmpdir"
    sandbox.mkdir()
    monkeypatch.setattr(tempfile_mod, "tempdir", str(sandbox))
    key_bytes = b"-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n"
    real_write = os.write

    def boom_write(fd, data):
        if bytes(data) == key_bytes:
            raise OSError("injected key-copy write failure")
        return real_write(fd, data)

    monkeypatch.setattr("porch3.initcli.os.write", boom_write)
    assert _pub_matches_private_bytes(key_bytes, "ssh-ed25519 AAAA") is False
    assert list(sandbox.iterdir()) == []


def test_temp_key_copy_cleanup_failure_is_surfaced(tmp_path, monkeypatch):
    """A cleanup that cannot remove the secret must raise, not return quietly."""
    import shutil
    import tempfile as tempfile_mod

    from porch3.initcli import _pub_matches_private_bytes

    sandbox = tmp_path / "tmpdir"
    sandbox.mkdir()
    monkeypatch.setattr(tempfile_mod, "tempdir", str(sandbox))
    real_unlink = os.unlink

    def refuse_unlink(path, *args, **kwargs):
        # rmtree unlinks by bare name relative to a held dirfd.
        if Path(str(path)).name == "material":
            raise OSError("injected unlink failure")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(os, "unlink", refuse_unlink)
    with pytest.raises(InitError, match="temporary private key copy") as ei:
        _pub_matches_private_bytes(b"key-material\n", "ssh-ed25519 AAAA")
    assert ei.value.exit_code == 4
    leftovers = list(sandbox.glob("porch-keycopy-*"))
    assert len(leftovers) == 1
    # The error names the directory still holding the private bytes.
    assert str(leftovers[0]) in str(ei.value)
    assert (leftovers[0] / "material").read_bytes() == b"key-material\n"
    monkeypatch.undo()
    shutil.rmtree(leftovers[0])


def test_temp_key_copy_is_private_and_matches_real_key(init_env, monkeypatch):
    """The copy stays 0600 under a 0700 dir while ssh-keygen reads it."""
    from porch3.initcli import _pub_core_from_text, _pub_matches_private_bytes

    assert _run(init_env) == 0
    cfg = init_env["cfg"]
    key_bytes = cfg.key_file.read_bytes()
    pub_core = _pub_core_from_text(
        Path(str(cfg.key_file) + ".pub").read_text(encoding="utf-8")
    )
    seen: list[tuple[int, int]] = []
    real_run = subprocess.run

    def spy_run(cmd, **kwargs):
        copy = Path(cmd[cmd.index("-f") + 1])
        seen.append(
            (
                stat.S_IMODE(copy.stat().st_mode),
                stat.S_IMODE(copy.parent.stat().st_mode),
            )
        )
        return real_run(cmd, **kwargs)

    monkeypatch.setattr("porch3.initcli.subprocess.run", spy_run)
    assert _pub_matches_private_bytes(key_bytes, pub_core) is True
    assert seen == [(0o600, 0o700)]
    assert _pub_matches_private_bytes(key_bytes, "ssh-ed25519 WRONGKEY") is False


def test_rollback_restores_preexisting_signers_mode_and_bytes(init_env, monkeypatch):
    """Item 4: the append tightens 0644 to 0600, so rollback must undo both."""
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    original = b"# operator managed\n"
    signers.write_bytes(original)
    os.chmod(signers, 0o644)

    def boom(*a, **k):
        raise InitError("forced config failure")

    monkeypatch.setattr("porch3.initcli._write_config_atomic", boom)
    with pytest.raises(InitError, match="forced config failure"):
        _run(init_env)
    assert signers.read_bytes() == original
    assert stat.S_IMODE(signers.stat().st_mode) == 0o644


def test_exact_line_mode_tighten_rolls_back_on_config_failure(init_env, monkeypatch):
    """Round-7 item 6: exact-line 0644→0600 must register restore before fchmod."""
    assert _run(init_env) == 0
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    original = signers.read_bytes()
    os.chmod(signers, 0o644)
    init_env["conf"].unlink()

    def boom(*a, **k):
        raise InitError("forced config failure")

    monkeypatch.setattr("porch3.initcli._write_config_atomic", boom)
    with pytest.raises(InitError, match="forced config failure"):
        _run(init_env)
    assert signers.read_bytes() == original
    assert stat.S_IMODE(signers.stat().st_mode) == 0o644


def test_restore_signers_chmods_under_the_same_lock(init_env, monkeypatch):
    """fchmod must land while the exclusive lock is still held."""
    from porch3.initcli import _restore_signers

    order: list[str] = []
    real_flock = fcntl.flock
    real_fchmod = os.fchmod

    def spy_flock(fd, op):
        order.append("unlock" if op == fcntl.LOCK_UN else "flock")
        return real_flock(fd, op)

    def spy_fchmod(fd, mode):
        order.append("fchmod")
        return real_fchmod(fd, mode)

    monkeypatch.setattr("porch3.initcli.fcntl.flock", spy_flock)
    monkeypatch.setattr("porch3.initcli.os.fchmod", spy_fchmod)
    path = init_env["tmp"] / "signers-mode"
    path.write_bytes(b"old\n")
    os.chmod(path, 0o600)
    _restore_signers(path, b"restored\n", 0o644)
    assert path.read_bytes() == b"restored\n"
    assert stat.S_IMODE(path.stat().st_mode) == 0o644
    assert order.index("flock") < order.index("fchmod")
    assert "unlock" not in order[: order.index("fchmod")]


def test_match_pattern_list_follows_openssh_semantics():
    """Item 3: `*`/`?` globbing with a negated hit beating any positive."""
    from porch3.initcli import _match_pattern, _match_pattern_list

    assert _match_pattern("*", "mara@porch")
    assert _match_pattern("mara@?orch", "mara@porch")
    assert not _match_pattern("mara@?orch", "mara@pporch")
    assert _match_pattern("m*a@*h", "mara@porch")
    assert not _match_pattern("mara", "mara@porch")
    assert not _match_pattern_list("!mara@porch,*", "mara@porch")
    assert _match_pattern_list("*,!river@porch", "mara@porch")
    assert not _match_pattern_list("river@porch,!*", "mara@porch")
    assert _match_pattern_list("river@porch,mara@porch", "mara@porch")
    assert not _match_pattern_list("", "mara@porch")


@pytest.mark.parametrize(
    "patterns", ["*", "mara@porch,other", "other,mara@porch", "mara@*", "mara?porch"]
)
def test_signers_pattern_list_collision_refused(init_env, patterns):
    """A PATTERNS field that already authorizes our principal must refuse."""
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    signers.write_text(
        f'{patterns} namespaces="{cfg.signing_namespace}" ssh-ed25519 OTHERKEY\n'
    )
    with pytest.raises(InitError, match="conflicting pattern-list"):
        _run(init_env)
    assert not init_env["conf"].exists()
    assert not cfg.key_file.exists()


def test_signers_negated_pattern_alone_does_not_collide(init_env):
    """`!mara@porch,other` denies mara, so it is not a competing grant."""
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    denial = (
        f'!{cfg.principal},other namespaces="{cfg.signing_namespace}" '
        "ssh-ed25519 OTHERKEY\n"
    )
    signers.write_text(denial)
    assert _run(init_env) == 0
    text = signers.read_text()
    assert text.startswith(denial)
    assert f'{cfg.principal} namespaces="{cfg.signing_namespace}"' in text


def test_signers_unrelated_principal_and_comments_allowed(init_env):
    """Comments, blanks, and other principals must not block the append."""
    cfg = init_env["cfg"]
    signers = cfg.allowed_signers
    signers.parent.mkdir(parents=True, exist_ok=True)
    other = 'river@porch namespaces="river-porch" ssh-ed25519 RIVERKEY\n'
    signers.write_text("# operator notes\n\n" + other)
    assert _run(init_env) == 0
    text = signers.read_text()
    assert other in text
    assert f'{cfg.principal} namespaces="{cfg.signing_namespace}"' in text


def test_signers_exact_line_scan_survives_pattern_check(init_env):
    """Item 3 supplements the exact-line scan; it must not replace it."""
    assert _run(init_env) == 0
    cfg = init_env["cfg"]
    init_env["conf"].unlink()
    signers = cfg.allowed_signers
    signers.write_text(
        f'{cfg.principal} namespaces="wrong" ssh-ed25519 AAAA\n'
    )
    with pytest.raises(InitError, match="different line"):
        _run(init_env)


def test_partial_private_key_write_rolls_back_named_path(init_env, monkeypatch):
    """Item 1: the O_EXCL'd destination is rollback-owned before any write."""
    cfg = init_env["cfg"]
    key = cfg.key_file
    pub = Path(str(key) + ".pub")
    real_write = os.write

    def boom_write(fd, data):
        if b"PRIVATE KEY" in bytes(data):
            raise OSError("injected private-key write failure")
        return real_write(fd, data)

    monkeypatch.setattr("porch3.initcli.os.write", boom_write)
    with pytest.raises(InitError, match="cannot write") as ei:
        _run(init_env)
    assert str(key) in str(ei.value)
    assert not key.exists()
    assert not pub.exists()
    assert not init_env["conf"].exists()


def test_partial_public_key_write_rolls_back_both_paths(init_env, monkeypatch):
    """A pub-install failure must also unwind the already-installed private key."""
    cfg = init_env["cfg"]
    key = cfg.key_file
    pub = Path(str(key) + ".pub")
    real_write = os.write

    def boom_write(fd, data):
        if bytes(data).startswith(b"ssh-ed25519 "):
            raise OSError("injected public-key write failure")
        return real_write(fd, data)

    monkeypatch.setattr("porch3.initcli.os.write", boom_write)
    with pytest.raises(InitError, match="cannot write") as ei:
        _run(init_env)
    assert str(pub) in str(ei.value)
    assert not key.exists()
    assert not pub.exists()


def test_install_cleanup_failure_names_retained_key_path(init_env, monkeypatch):
    """A rollback that cannot unlink the orphan must name it, not swallow it."""
    cfg = init_env["cfg"]
    key = cfg.key_file
    real_write = os.write
    real_unlink = Path.unlink

    def boom_write(fd, data):
        if b"PRIVATE KEY" in bytes(data):
            raise OSError("injected private-key write failure")
        return real_write(fd, data)

    def refuse_unlink(self, *a, **k):
        if self == key:
            raise OSError("injected unlink failure")
        return real_unlink(self, *a, **k)

    monkeypatch.setattr("porch3.initcli.os.write", boom_write)
    monkeypatch.setattr(Path, "unlink", refuse_unlink)
    with pytest.raises(InitError, match="rollback incomplete") as ei:
        _run(init_env)
    msg = str(ei.value)
    assert str(key) in msg
    assert "cleanup failed" in msg
    # The named path is the empty file O_EXCL created before the failed write.
    assert key.exists()
    assert key.read_bytes() == b""


def test_adoption_mode_judged_from_held_fstat_not_pathname(init_env, monkeypatch):
    """Loosening the pathname after the held read must not change the verdict."""
    from porch3 import initcli as initcli_mod

    assert _run(init_env) == 0
    cfg = init_env["cfg"]
    key = cfg.key_file
    init_env["conf"].unlink()
    real_held = initcli_mod._read_regular_held

    def loosen_after_read(path, *, limit, label):
        held = real_held(path, limit=limit, label=label)
        if label == "private key":
            # An os.lstat(key) after the read would see 0644 and refuse.
            os.chmod(path, 0o644)
        return held

    monkeypatch.setattr(initcli_mod, "_read_regular_held", loosen_after_read)
    assert _run(init_env) == 0
    assert stat.S_IMODE(key.stat().st_mode) == 0o644


def test_adoption_refuses_loose_held_fstat_despite_later_tighten(
    init_env, monkeypatch
):
    """Inverse: a 0644 snapshot refuses even once the pathname turns 0600."""
    from porch3 import initcli as initcli_mod

    assert _run(init_env) == 0
    cfg = init_env["cfg"]
    key = cfg.key_file
    init_env["conf"].unlink()
    os.chmod(key, 0o644)
    real_held = initcli_mod._read_regular_held

    def tighten_after_read(path, *, limit, label):
        held = real_held(path, limit=limit, label=label)
        if label == "private key":
            os.chmod(path, 0o600)
        return held

    monkeypatch.setattr(initcli_mod, "_read_regular_held", tighten_after_read)
    with pytest.raises(InitError, match="want 0600"):
        _run(init_env)
    assert stat.S_IMODE(key.stat().st_mode) == 0o600
    assert not init_env["conf"].exists()
