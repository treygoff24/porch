"""Doctor tool probes: version + post owner surface (B3)."""

from __future__ import annotations

from pathlib import Path

import pytest

from porchd import toolprobe


def _stub(tmp_path: Path, name: str, body: str) -> Path:
    path = tmp_path / name
    path.write_text(body)
    path.chmod(0o755)
    return path


def test_version_only_post_stub_fails_owner_probe(tmp_path, monkeypatch):
    """Installed post that only answers --version must not pass doctor."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(
        bin_dir,
        "post",
        "#!/bin/sh\n"
        "if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"-V\" ]; then\n"
        "  echo 'post 0.4.0'\n"
        "  exit 0\n"
        "fi\n"
        "echo 'error: unrecognized subcommand' >&2\n"
        "exit 2\n",
    )
    monkeypatch.setenv("PATH", str(bin_dir))
    # Ensure which sees only our stub.
    monkeypatch.setattr(toolprobe.shutil, "which", lambda n: str(bin_dir / n) if n == "post" else None)
    probe = toolprobe.probe_post()
    assert probe.ok is False
    assert "0.4.0" in probe.label
    assert "owner show" in probe.label


def test_post_stub_with_owner_show_help_passes(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(
        bin_dir,
        "post",
        "#!/bin/sh\n"
        "if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"-V\" ]; then\n"
        "  echo 'post 0.5.0'\n"
        "  exit 0\n"
        "fi\n"
        "if [ \"$1\" = \"owner\" ] && [ \"$2\" = \"show\" ] && [ \"$3\" = \"--help\" ]; then\n"
        "  echo 'Usage: post owner show'\n"
        "  exit 0\n"
        "fi\n"
        "exit 2\n",
    )
    monkeypatch.setattr(
        toolprobe.shutil, "which", lambda n: str(bin_dir / n) if n == "post" else None
    )
    probe = toolprobe.probe_post()
    assert probe.ok is True
    assert "0.5.0" in probe.label
    assert "owner show present" in probe.label


def test_owner_show_arbitrary_failure_is_not_present(tmp_path):
    """rc!=0 prose must never fail-open as 'owner show present'."""
    path = _stub(
        tmp_path,
        "post",
        "#!/bin/sh\necho 'fatal: exploded' >&2\nexit 2\n",
    )
    ok, detail = toolprobe.post_owner_show_present(str(path))
    assert ok is False
    assert "present" not in detail


def test_owner_show_help_requires_exact_usage(tmp_path):
    path = _stub(
        tmp_path,
        "post",
        "#!/bin/sh\necho 'Usage: post owner'\nexit 0\n",
    )
    ok, detail = toolprobe.post_owner_show_present(str(path))
    assert ok is False
    assert "Usage: post owner show" in detail


def test_post_missing_from_path(monkeypatch):
    monkeypatch.setattr(toolprobe.shutil, "which", lambda n: None)
    probe = toolprobe.probe_post()
    assert probe.ok is False
    assert probe.label == "post on PATH"


def test_named_tool_reports_version(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(
        bin_dir,
        "ssh-add",
        "#!/bin/sh\necho 'OpenSSH_9.0'\n",
    )
    monkeypatch.setattr(
        toolprobe.shutil, "which", lambda n: str(bin_dir / "ssh-add") if n == "ssh-add" else None
    )
    probe = toolprobe.probe_named_tool("ssh-add")
    assert probe.ok is True
    assert "OpenSSH" in probe.label


def test_version_string_rejects_nonzero_error_prose(tmp_path):
    """rc!=0 stderr must not be reported as a version (illegal option case)."""
    path = _stub(
        tmp_path,
        "ssh-add",
        "#!/bin/sh\necho 'illegal option -- -' >&2\nexit 2\n",
    )
    assert toolprobe.version_string(str(path), name="ssh-add") == (
        "ssh-add (version unavailable)"
    )


def test_probe_resolved_binary_reports_version(tmp_path):
    path = _stub(
        tmp_path,
        "Tailscale",
        "#!/bin/sh\necho '1.68.0'\n",
    )
    probe = toolprobe.probe_resolved_binary(str(path), name="tailscale")
    assert probe.ok is True
    assert "1.68.0" in probe.label


def test_probe_resolved_binary_missing():
    probe = toolprobe.probe_resolved_binary(None, name="tailscale")
    assert probe.ok is False
    assert probe.label == "tailscale present"


def test_probe_resolved_binary_optional_absence():
    probe = toolprobe.probe_resolved_binary(None, name="tailscale", optional=True)
    assert probe.ok is False
    assert probe.label == "tailscale present (optional)"


def test_optional_tool_absence_is_labeled(monkeypatch):
    monkeypatch.setattr(toolprobe.shutil, "which", lambda n: None)
    probe = toolprobe.probe_named_tool("qrencode", optional=True)
    assert probe.ok is False
    assert "optional" in probe.label
