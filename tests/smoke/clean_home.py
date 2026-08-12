#!/usr/bin/env python3
"""B6a — clean-home install smoke harness (design v3).

Proves a stranger's cold start end-to-end from public-shaped artifacts through
installed commands, pairing, signed/unsigned/DR sends, and the full verifier
taxonomy — without touching live HOME state or registering worktrees in the
source checkouts.

Run from a porch checkout whose HEAD is the release tree:

    python3 tests/smoke/clean_home.py
    python3 tests/smoke/clean_home.py --post-src /path/to/post

Isolation: synthetic HOME under tempfile.mkdtemp. shutil.rmtree only on
success; on failure the tree is preserved and its path is printed. No
executed command line contains ``rm``.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import urlparse

RELEASE_TAG = "v1.0.0"
RELEASE_VERSION = "1.0.0"
UPGRADE_TAG = "v1.0.1"
UPGRADE_VERSION = "1.0.1"
POST_TAG = "v0.4.1"
POST_RELEASE_SHA = "e74a91c1d44c702c41ff73c1afd02edbcf38fce3"
PAIR_BASE = "https://smoke.invalid"
OWNER_ROOM = "smoke"
OWNER_MARKER = "🧪"
OWNER_LABEL = "Smoke"  # default_label_for("smoke")
CHANNEL = "commons"
LAUNCH_LABEL = "dev.porch.porchd"

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIP_MANIFEST = REPO_ROOT / "docs" / "plans" / "manifest-ship.txt"
STATIC_RELATIVE = [
    "porchd/static/app.js",
    "porchd/static/index.html",
    "porchd/static/manifest.webmanifest",
    "porchd/static/style.css",
    "porchd/static/icons/icon-180.png",
    "porchd/static/icons/icon-192.png",
    "porchd/static/icons/icon-512.png",
    "porchd/static/icons/icon-maskable-512.png",
]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


@dataclass
class StepResult:
    number: int
    title: str
    command: str
    status: str  # PASS | FAIL | SKIP
    detail: str = ""


@dataclass
class Harness:
    root: Path
    real_home: Path
    home: Path
    post_src: Path
    port: int
    results: list[StepResult] = field(default_factory=list)
    static_urls: list[str] = field(default_factory=list)
    _step: int = 0
    _daemon: subprocess.Popen[bytes] | None = None
    _failed: bool = False
    versions: dict[str, str] = field(default_factory=dict)

    # Derived paths inside synthetic HOME
    @property
    def mail_root(self) -> Path:
        return self.home / ".claude-mail"

    @property
    def state_root(self) -> Path:
        return self.home / "state"

    @property
    def room_dir(self) -> Path:
        return self.home / "rooms" / OWNER_ROOM

    @property
    def uv_tool_dir(self) -> Path:
        return self.home / "uv-tools"

    @property
    def uv_bin(self) -> Path:
        return self.home / "uv-bin"

    @property
    def pipx_home(self) -> Path:
        return self.home / "pipx-home"

    @property
    def pipx_bin(self) -> Path:
        return self.home / "pipx-bin"

    @property
    def local_bin(self) -> Path:
        return self.home / ".local" / "bin"

    @property
    def shim_dir(self) -> Path:
        return self.home / "shims"

    @property
    def export_dir(self) -> Path:
        return self.root / "export"

    @property
    def post_clone(self) -> Path:
        return self.root / "post-src"

    @property
    def wheel_dir(self) -> Path:
        return self.root / "wheel"

    @property
    def launchctl_log(self) -> Path:
        return self.shim_dir / "launchctl.argv.log"

    @property
    def tailscale_log(self) -> Path:
        return self.shim_dir / "tailscale.argv.log"

    def base_env(self) -> dict[str, str]:
        """Synthetic-home env for every child. PYTHONPATH is intentionally absent."""
        path_parts = [
            str(self.shim_dir),
            str(self.uv_bin),
            str(self.pipx_bin),
            str(self.local_bin),
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]
        # Keep cargo/rustup discoverable for the post build without leaking
        # the operator's real uv/pipx tool installs ahead of synthetic bins.
        cargo_bin = self.real_home / ".cargo" / "bin"
        if cargo_bin.is_dir():
            path_parts.append(str(cargo_bin))
        # Absolute cargo from the parent environment as a last-resort PATH entry.
        parent_cargo = shutil.which("cargo")
        if parent_cargo:
            parent_cargo_dir = str(Path(parent_cargo).resolve().parent)
            if parent_cargo_dir not in path_parts:
                path_parts.append(parent_cargo_dir)
        env = {
            "HOME": str(self.home),
            "POST_MAIL_ROOT": str(self.mail_root),
            "PORCHD_STATE_ROOT": str(self.state_root),
            "UV_TOOL_DIR": str(self.uv_tool_dir),
            "UV_TOOL_BIN_DIR": str(self.uv_bin),
            "PIPX_HOME": str(self.pipx_home),
            "PIPX_BIN_DIR": str(self.pipx_bin),
            "PATH": os.pathsep.join(path_parts),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "LC_ALL": os.environ.get("LC_ALL", "en_US.UTF-8"),
            "TERM": os.environ.get("TERM", "xterm-256color"),
            # Rustup resolves toolchains under $HOME/.rustup unless pinned —
            # keep the operator's existing toolchain visible under synthetic HOME.
            "CARGO_HOME": os.environ.get(
                "CARGO_HOME", str(self.real_home / ".cargo")
            ),
            "RUSTUP_HOME": os.environ.get(
                "RUSTUP_HOME", str(self.real_home / ".rustup")
            ),
        }
        for key in ("TMPDIR", "TMP", "TEMP", "RUSTUP_TOOLCHAIN"):
            if key in os.environ:
                env[key] = os.environ[key]
        return env

    def assert_isolation(self) -> None:
        if self.home.resolve() == self.real_home.resolve():
            raise SystemExit("ABORT: synthetic HOME equals real home")
        for label, path in (
            ("HOME", self.home),
            ("POST_MAIL_ROOT", self.mail_root),
            ("PORCHD_STATE_ROOT", self.state_root),
            ("UV_TOOL_DIR", self.uv_tool_dir),
            ("UV_TOOL_BIN_DIR", self.uv_bin),
            ("PIPX_HOME", self.pipx_home),
            ("PIPX_BIN_DIR", self.pipx_bin),
        ):
            # Resolve consistently (macOS /var → /private/var). Parents of
            # not-yet-created paths still resolve via the existing ancestor.
            resolved = path.resolve()
            root_resolved = self.root.resolve()
            try:
                resolved.relative_to(root_resolved)
            except ValueError as exc:
                raise SystemExit(
                    f"ABORT: {label}={resolved} escapes temp tree {root_resolved}"
                ) from exc
        if "PYTHONPATH" in os.environ:
            # Parent may have it; children must not. base_env omits it.
            pass

    def next_step(self, title: str) -> int:
        self._step += 1
        print(f"\n=== [{self._step}] {title} ===", flush=True)
        return self._step

    def record(
        self, number: int, title: str, command: str, status: str, detail: str = ""
    ) -> None:
        self.results.append(
            StepResult(number, title, command, status, detail)
        )
        suffix = f" — {detail}" if detail else ""
        print(f"{status}: {title}{suffix}", flush=True)
        if status == "FAIL":
            self._failed = True

    def run(
        self,
        argv: Sequence[str],
        *,
        title: str,
        env: Mapping[str, str] | None = None,
        cwd: Path | None = None,
        check: bool = True,
        expect_rc: int | None = None,
        timeout: float | None = 120,
        input_text: str | None = None,
        shell_command: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Run one command, print it, record PASS/FAIL. First failure raises."""
        number = self.next_step(title)
        if shell_command is not None:
            display = shell_command
            if " rm " in f" {shell_command} " or shell_command.strip().startswith("rm "):
                self.record(number, title, display, "FAIL", "command contains rm")
                raise RuntimeError("refusing command that contains rm")
            cmd_argv: Sequence[str] = ["bash", "-lc", shell_command]
        else:
            display = " ".join(shlex.quote(a) for a in argv)
            if any(a == "rm" or a.startswith("rm") for a in argv):
                # Only refuse the deletion utility as argv0 / standalone token.
                if argv and Path(argv[0]).name == "rm":
                    self.record(number, title, display, "FAIL", "command contains rm")
                    raise RuntimeError("refusing command that contains rm")
            cmd_argv = argv

        print(f"$ {display}", flush=True)
        child_env = dict(env if env is not None else self.base_env())
        child_env.pop("PYTHONPATH", None)
        try:
            proc = subprocess.run(
                list(cmd_argv),
                cwd=str(cwd) if cwd else None,
                env=child_env,
                capture_output=True,
                text=True,
                timeout=timeout,
                input=input_text,
            )
        except subprocess.TimeoutExpired as exc:
            self.record(number, title, display, "FAIL", f"timeout after {timeout}s")
            raise RuntimeError(f"timeout: {title}") from exc
        except OSError as exc:
            self.record(number, title, display, "FAIL", str(exc))
            raise

        out = (proc.stdout or "") + (proc.stderr or "")
        if out.strip():
            # Bound chatter; full logs live in the preserved tree on failure.
            clipped = out if len(out) < 4000 else out[:4000] + "\n…[clipped]…"
            print(clipped, flush=True)

        wanted = expect_rc if expect_rc is not None else (0 if check else proc.returncode)
        if check or expect_rc is not None:
            if proc.returncode != wanted:
                self.record(
                    number,
                    title,
                    display,
                    "FAIL",
                    f"rc={proc.returncode} want={wanted}",
                )
                raise RuntimeError(
                    f"step {number} failed: {title} (rc={proc.returncode})"
                )
        self.record(number, title, display, "PASS", f"rc={proc.returncode}")
        return proc

    def which(self, name: str, env: Mapping[str, str] | None = None) -> Path:
        found = shutil.which(name, path=(env or self.base_env()).get("PATH"))
        if not found:
            raise RuntimeError(f"{name} not found on harness PATH")
        return Path(found)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def resolve_post_src(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser().resolve()
    else:
        env = os.environ.get("PORCH_SMOKE_POST_CHECKOUT")
        if env:
            path = Path(env).expanduser().resolve()
        else:
            sibling = REPO_ROOT.parent / "post"
            path = sibling.resolve()
    if not (path / "Cargo.toml").is_file():
        raise SystemExit(
            f"post checkout not found at {path}; pass --post-src or set "
            "PORCH_SMOKE_POST_CHECKOUT"
        )
    # Confirm the immutable release commit without mutating the checkout.
    tip = subprocess.run(
        ["git", "rev-parse", f"{POST_TAG}^{{commit}}"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if tip != POST_RELEASE_SHA:
        raise SystemExit(
            f"{path} {POST_TAG}^{{commit}} is {tip}, expected {POST_RELEASE_SHA}"
        )
    return path


def tool_versions(h: Harness) -> None:
    for name, argv in (
        ("python", [sys.executable, "--version"]),
        ("git", ["git", "--version"]),
        ("uv", ["uv", "--version"]),
        ("pipx", ["pipx", "--version"]),
        ("cargo", ["cargo", "--version"]),
    ):
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=30)
            blob = (proc.stdout or proc.stderr or "").strip().splitlines()
            h.versions[name] = blob[0] if blob else f"rc={proc.returncode}"
        except (OSError, subprocess.TimeoutExpired) as exc:
            h.versions[name] = f"unavailable: {exc}"


def write_executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def install_shims(h: Harness) -> None:
    """Fail-closed launchctl + tailscale PATH shims that log argv."""
    h.shim_dir.mkdir(parents=True, exist_ok=True)
    h.launchctl_log.write_text("", encoding="utf-8")
    h.tailscale_log.write_text("", encoding="utf-8")
    expected_serve = f"http://127.0.0.1:{h.port}"

    write_executable(
        h.shim_dir / "launchctl",
        f"""#!/usr/bin/env python3
import json, pathlib, sys
log = pathlib.Path({str(h.launchctl_log)!r})
argv = sys.argv[1:]
with log.open("a", encoding="utf-8") as fh:
    fh.write(json.dumps(argv, ensure_ascii=False) + "\\n")
# Exact families only: list LABEL | load|unload <plist>
if len(argv) == 2 and argv[0] == "list":
    sys.exit(0 if argv[1] == {LAUNCH_LABEL!r} else 1)
if len(argv) == 2 and argv[0] in ("load", "unload") and argv[1].endswith(".plist"):
    sys.exit(0)
sys.exit(1)
""",
    )

    write_executable(
        h.shim_dir / "tailscale",
        f"""#!/usr/bin/env python3
import json, pathlib, sys
log = pathlib.Path({str(h.tailscale_log)!r})
state = pathlib.Path({str(h.shim_dir / "tailscale.state.json")!r})
argv = sys.argv[1:]
with log.open("a", encoding="utf-8") as fh:
    fh.write(json.dumps(argv, ensure_ascii=False) + "\\n")
if not argv:
    sys.exit(1)
if argv == ["--version"] or argv == ["-V"] or argv == ["version"]:
    print("1.0.0-smoke-shim")
    sys.exit(0)
if argv == ["status", "--json"] or (argv[0] == "status" and "--json" in argv and len(argv) == 2):
    # No DNSName → hostname unknown; operator --base-url covers pairing.
    print(json.dumps({{"Self": {{"DNSName": ""}}}}))
    sys.exit(0)
if argv == ["serve", "status", "--json"]:
    target = ""
    if state.is_file():
        target = state.read_text(encoding="utf-8").strip()
    if target:
        print(json.dumps({{"TCP": {{"443": {{"HTTPS": True, "Handlers": {{"/": {{"Proxy": target}}}}}}}}}}))
    else:
        print("{{}}")
    sys.exit(0)
if argv == ["serve", "--bg", "--https=443", {expected_serve!r}]:
    state.write_text(argv[-1], encoding="utf-8")
    sys.exit(0)
# Fail closed on anything unexpected (never touch real Tailscale).
sys.exit(1)
""",
    )


def wait_for_port(port: int, *, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"daemon did not listen on 127.0.0.1:{port}")


def http_json(
    port: int,
    method: str,
    path: str,
    *,
    body: dict | None = None,
    host: str,
    origin: str | None,
    cookie: str | None = None,
    csrf: str | None = None,
) -> tuple[int, dict, Mapping[str, str]]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    headers = {
        "Host": host,
        "Connection": "close",
        "Content-Type": "application/json",
    }
    if origin is not None:
        headers["Origin"] = origin
    if cookie:
        headers["Cookie"] = cookie
    if csrf:
        headers["X-Porch-CSRF"] = csrf
    payload = json.dumps(body).encode() if body is not None else None
    if method == "GET":
        payload = None
    conn.request(method, path, body=payload, headers=headers)
    response = conn.getresponse()
    raw = response.read()
    hdrs = {k: v for k, v in response.getheaders()}
    conn.close()
    data: dict
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        data = {"_raw": raw.decode("utf-8", "replace")}
    return response.status, data, hdrs


def http_get_status(port: int, path: str, *, host: str) -> int:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request(
        "GET",
        path,
        headers={"Host": host, "Connection": "close"},
    )
    response = conn.getresponse()
    response.read()
    status = response.status
    conn.close()
    return status


def extract_pair_token(text: str) -> str:
    match = re.search(r"#pair=([A-Za-z0-9_-]+)", text)
    if not match:
        raise RuntimeError("pairing token not found in porch-mobile pair output")
    return match.group(1)


def extract_owner_init_command(text: str) -> str:
    """Pull the exact ``env POST_MAIL_ROOT=… post owner init …`` command."""
    # Command may wrap across the InitError prose; prefer a single-line match.
    match = re.search(
        r"(env POST_MAIL_ROOT=(?:'[^']+'|\"[^\"]+\"|\S+) post owner init[^\n`]*)",
        text,
    )
    if not match:
        raise RuntimeError(f"post owner init command not found in:\n{text}")
    return match.group(1).strip().rstrip(".")


def bump_export_version(export: Path, version: str) -> None:
    pyproject = export / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    text, n = re.subn(
        r'(?m)^version\s*=\s*"[^"]*"',
        f'version = "{version}"',
        text,
        count=1,
    )
    if n != 1:
        raise RuntimeError("failed to bump export pyproject.toml version")
    pyproject.write_text(text, encoding="utf-8")
    # Single source fallback lives in porch3; porchd imports that symbol.
    path = export / "src/porch3/__init__.py"
    body = path.read_text(encoding="utf-8")
    body2, n = re.subn(
        r'__version__\s*=\s*"[^"]*"',
        f'__version__ = "{version}"',
        body,
        count=1,
    )
    if n != 1:
        raise RuntimeError("failed to bump fallback version in src/porch3/__init__.py")
    path.write_text(body2, encoding="utf-8")


def git_smoke_env(h: Harness) -> dict[str, str]:
    """Synthetic-HOME env for export-repo git ops — no real global config."""
    env = dict(h.base_env())
    env.update(
        {
            "GIT_AUTHOR_NAME": "porch-smoke",
            "GIT_AUTHOR_EMAIL": "smoke@invalid",
            "GIT_COMMITTER_NAME": "porch-smoke",
            "GIT_COMMITTER_EMAIL": "smoke@invalid",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    return env


def git_init_empty(repo: Path, *, env: Mapping[str, str], template: Path) -> None:
    template.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", f"--template={template}"],
        cwd=repo,
        check=True,
        capture_output=True,
        env=dict(env),
    )
    for key, value in (
        ("user.email", "smoke@invalid"),
        ("user.name", "porch-smoke"),
        ("commit.gpgsign", "false"),
        ("tag.gpgSign", "false"),
        ("core.hooksPath", "/dev/null"),
    ):
        subprocess.run(
            ["git", "config", key, value],
            cwd=repo,
            check=True,
            capture_output=True,
            env=dict(env),
        )


def git_commit_all(repo: Path, message: str, *, env: Mapping[str, str]) -> None:
    subprocess.run(
        ["git", "add", "-A"],
        cwd=repo,
        check=True,
        capture_output=True,
        env=dict(env),
    )
    subprocess.run(
        [
            "git",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--no-verify",
            "-m",
            message,
        ],
        cwd=repo,
        check=True,
        capture_output=True,
        env=dict(env),
    )


def git_tag(repo: Path, tag: str, *, env: Mapping[str, str]) -> None:
    subprocess.run(
        ["git", "-c", "tag.gpgSign=false", "tag", tag],
        cwd=repo,
        check=True,
        capture_output=True,
        env=dict(env),
    )


def installed_module_versions(python: Path) -> tuple[str, str, str]:
    proc = subprocess.run(
        [
            str(python),
            "-c",
            "import importlib.metadata as m, porch3, porchd; "
            "print(m.version('porch3')); print(porch3.__version__); print(porchd.__version__)",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    if len(lines) != 3:
        raise RuntimeError(f"unexpected version probe output: {proc.stdout!r}")
    return lines[0], lines[1], lines[2]


def uv_tool_python(h: Harness) -> Path:
    candidate = h.uv_tool_dir / "porch3" / "bin" / "python"
    if candidate.is_file():
        return candidate
    # uv layout may nest under share; search once.
    matches = list(h.uv_tool_dir.glob("**/porch3/**/bin/python"))
    if not matches:
        raise RuntimeError(f"uv tool python not found under {h.uv_tool_dir}")
    return matches[0]


def pipx_env_python(h: Harness) -> Path:
    candidate = h.pipx_home / "venvs" / "porch3" / "bin" / "python"
    if candidate.is_file():
        return candidate
    matches = list(h.pipx_home.glob("**/porch3/**/bin/python"))
    if not matches:
        raise RuntimeError(f"pipx env python not found under {h.pipx_home}")
    return matches[0]


def discover_static_urls(wheel_names: Sequence[str]) -> list[str]:
    """Map wheel porchd/static/* members to HTTP paths (+ / alias)."""
    urls: set[str] = set()
    marker = "porchd/static/"
    for name in wheel_names:
        norm = name.replace("\\", "/")
        if marker not in norm or norm.endswith("/"):
            continue
        rel = norm[norm.index(marker) + len(marker) :]
        if not rel or rel.endswith("/"):
            continue
        urls.add("/" + rel)
    if not urls:
        raise RuntimeError("wheel contained no porchd/static/* entries")
    # / aliases index.html when present.
    if "/index.html" in urls:
        urls.add("/")
    return sorted(urls)


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


def stage_a(h: Harness) -> Path:
    """Build the public-shaped export + inspect the wheel. Returns wheel path."""
    # 1. Version precondition on the SOURCE checkout (must already be bumped).
    number = h.next_step("version precondition on source checkout")
    print("$ assert pyproject + module fallbacks == 1.0.0", flush=True)
    pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    if not re.search(
        rf'(?m)^version\s*=\s*"{re.escape(RELEASE_VERSION)}"', pyproject
    ):
        h.record(
            number,
            "version precondition on source checkout",
            "read pyproject.toml",
            "FAIL",
            f"expected version {RELEASE_VERSION}",
        )
        raise RuntimeError("source pyproject.toml is not at release version")
    for rel in ("src/porch3/__init__.py",):
        body = (REPO_ROOT / rel).read_text(encoding="utf-8")
        if f'__version__ = "{RELEASE_VERSION}"' not in body:
            h.record(
                number,
                "version precondition on source checkout",
                rel,
                "FAIL",
                "fallback __version__ mismatch",
            )
            raise RuntimeError(f"{rel} fallback version is not {RELEASE_VERSION}")
    porchd_init = (REPO_ROOT / "src/porchd/__init__.py").read_text(encoding="utf-8")
    if "from porch3 import __version__" not in porchd_init:
        h.record(
            number,
            "version precondition on source checkout",
            "src/porchd/__init__.py",
            "FAIL",
            "porchd must import porch3.__version__",
        )
        raise RuntimeError("porchd.__version__ must come from porch3")
    h.record(
        number,
        "version precondition on source checkout",
        "pyproject + porch3 fallback + porchd import",
        "PASS",
        RELEASE_VERSION,
    )

    # 2. Export from SHIP manifest only.
    ship = [
        ln.strip()
        for ln in SHIP_MANIFEST.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    h.export_dir.mkdir(parents=True, exist_ok=True)
    number = h.next_step("git archive HEAD through manifest-ship.txt → export repo")
    display = "git archive --format=tar HEAD -- <ship paths>"
    print(f"$ {display}", flush=True)
    try:
        raw = subprocess.run(
            ["git", "archive", "--format=tar", "HEAD", "--", *ship],
            cwd=REPO_ROOT,
            capture_output=True,
            check=True,
        ).stdout
        extract = h.root / "export-extract"
        extract.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["tar", "-xf", "-"],
            cwd=extract,
            input=raw,
            check=True,
            capture_output=True,
        )
        for child in extract.iterdir():
            dest = h.export_dir / child.name
            if dest.exists():
                if dest.is_dir():
                    shutil.rmtree(dest)
                else:
                    dest.unlink()
            shutil.move(str(child), str(dest))
        private_hits = []
        for path in h.export_dir.rglob("*"):
            rel = path.relative_to(h.export_dir).as_posix()
            if rel.startswith("docs/plans/") or rel.startswith("tmp/"):
                private_hits.append(rel)
        if private_hits:
            raise RuntimeError(f"private paths present: {private_hits[:5]}")
        git_env = git_smoke_env(h)
        git_init_empty(
            h.export_dir,
            env=git_env,
            template=h.root / "empty-git-template",
        )
        git_commit_all(h.export_dir, f"ship export {RELEASE_TAG}", env=git_env)
        git_tag(h.export_dir, RELEASE_TAG, env=git_env)
    except Exception as exc:
        h.record(number, "git archive → export repo", display, "FAIL", str(exc))
        raise
    h.record(number, "git archive → export repo", display, "PASS", RELEASE_TAG)

    # 3. Wheel inspection.
    h.wheel_dir.mkdir(parents=True, exist_ok=True)
    h.run(
        ["uv", "build", "--wheel", "--out-dir", str(h.wheel_dir)],
        title="uv build wheel from export",
        cwd=h.export_dir,
        timeout=300,
    )
    wheels = sorted(h.wheel_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected one wheel, found {wheels}")
    wheel = wheels[0]
    number = h.next_step("inspect wheel: static present, devfixtures absent")
    print(f"$ zipinfo-check {wheel.name}", flush=True)
    with zipfile.ZipFile(wheel) as zf:
        names = zf.namelist()
    missing_static = [
        rel for rel in STATIC_RELATIVE if not any(n.endswith(rel) for n in names)
    ]
    devfix = [n for n in names if "devfixtures" in n.replace("\\", "/")]
    if missing_static or devfix:
        h.record(
            number,
            "inspect wheel: static present, devfixtures absent",
            f"inspect {wheel.name}",
            "FAIL",
            f"missing={missing_static} devfixtures={devfix}",
        )
        raise RuntimeError("wheel inspection failed")
    h.static_urls = discover_static_urls(names)
    h.record(
        number,
        "inspect wheel: static present, devfixtures absent",
        f"inspect {wheel.name}",
        "PASS",
        f"{len(names)} entries; {len(h.static_urls)} static URLs",
    )
    return wheel


def stage_b(h: Harness, wheel: Path) -> None:
    export_uri = h.export_dir.resolve().as_uri()
    # 4. uv tool install
    h.run(
        [
            "uv",
            "tool",
            "install",
            f"git+{export_uri}@{RELEASE_TAG}",
        ],
        title="uv tool install @v1.0.0",
        timeout=300,
    )
    for cmd in ("porch", "porch-verify", "porch-mobile", "porch-dr"):
        bin_path = h.uv_bin / cmd
        h.run(
            [str(bin_path), "--help"],
            title=f"uv-installed {cmd} --help",
        )

    meta, v3, vd = installed_module_versions(uv_tool_python(h))
    number = h.next_step("uv install metadata/module versions == tag")
    print("$ python -c 'importlib.metadata + porch3/porchd versions'", flush=True)
    if meta != RELEASE_VERSION or v3 != RELEASE_VERSION or vd != RELEASE_VERSION:
        h.record(
            number,
            "uv install metadata/module versions == tag",
            "version probe",
            "FAIL",
            f"meta={meta} porch3={v3} porchd={vd}",
        )
        raise RuntimeError("installed versions disagree with tag")
    h.record(
        number,
        "uv install metadata/module versions == tag",
        "version probe",
        "PASS",
        meta,
    )

    # 5. pipx install (help/version only)
    h.run(
        [
            "pipx",
            "install",
            f"git+{export_uri}@{RELEASE_TAG}",
        ],
        title="pipx install @v1.0.0",
        timeout=300,
    )
    for cmd in ("porch", "porch-verify", "porch-mobile", "porch-dr"):
        h.run(
            [str(h.pipx_bin / cmd), "--help"],
            title=f"pipx-installed {cmd} --help",
        )

    meta_p, v3_p, vd_p = installed_module_versions(pipx_env_python(h))
    number = h.next_step("pipx install metadata/module versions == tag")
    print("$ pipx env python version probe @1.0.0", flush=True)
    if meta_p != RELEASE_VERSION or v3_p != RELEASE_VERSION or vd_p != RELEASE_VERSION:
        h.record(
            number,
            "pipx install metadata/module versions == tag",
            "version probe",
            "FAIL",
            f"meta={meta_p} porch3={v3_p} porchd={vd_p}",
        )
        raise RuntimeError("pipx installed versions disagree with tag")
    h.record(
        number,
        "pipx install metadata/module versions == tag",
        "version probe",
        "PASS",
        meta_p,
    )

    # 6. Upgrade + uninstall both; reinstall uv @v1.0.0 for Stage C.
    bump_export_version(h.export_dir, UPGRADE_VERSION)
    git_env = git_smoke_env(h)
    git_commit_all(h.export_dir, f"bump metadata to {UPGRADE_VERSION}", env=git_env)
    git_tag(h.export_dir, UPGRADE_TAG, env=git_env)
    h.run(
        [
            "uv",
            "tool",
            "install",
            "--force",
            f"git+{export_uri}@{UPGRADE_TAG}",
        ],
        title="uv tool install --force @v1.0.1",
        timeout=300,
    )
    meta_u, _, _ = installed_module_versions(uv_tool_python(h))
    number = h.next_step("uv force-upgrade reports 1.0.1")
    if meta_u != UPGRADE_VERSION:
        h.record(number, "uv force-upgrade reports 1.0.1", "probe", "FAIL", meta_u)
        raise RuntimeError("uv upgrade version mismatch")
    h.record(number, "uv force-upgrade reports 1.0.1", "probe", "PASS", meta_u)

    h.run(
        [
            "pipx",
            "install",
            "--force",
            f"git+{export_uri}@{UPGRADE_TAG}",
        ],
        title="pipx install --force @v1.0.1",
        timeout=300,
    )
    meta_pu, v3_pu, vd_pu = installed_module_versions(pipx_env_python(h))
    number = h.next_step("pipx force-upgrade reports 1.0.1")
    if meta_pu != UPGRADE_VERSION or v3_pu != UPGRADE_VERSION or vd_pu != UPGRADE_VERSION:
        h.record(
            number,
            "pipx force-upgrade reports 1.0.1",
            "probe",
            "FAIL",
            f"meta={meta_pu} porch3={v3_pu} porchd={vd_pu}",
        )
        raise RuntimeError("pipx upgrade version mismatch")
    h.record(number, "pipx force-upgrade reports 1.0.1", "probe", "PASS", meta_pu)

    h.run(["uv", "tool", "uninstall", "porch3"], title="uv tool uninstall porch3")
    h.run(["pipx", "uninstall", "porch3"], title="pipx uninstall porch3")
    number = h.next_step("assert uv/pipx bin commands gone")
    print(
        "$ test ! -e {uv,pipx}-bin/{porch,porch-verify,porch-mobile,porch-dr}",
        flush=True,
    )
    leftovers = [
        p
        for p in (
            *(h.uv_bin / cmd for cmd in ("porch", "porch-verify", "porch-mobile", "porch-dr")),
            *(h.pipx_bin / cmd for cmd in ("porch", "porch-verify", "porch-mobile", "porch-dr")),
        )
        if p.exists()
    ]
    if leftovers:
        h.record(number, "assert uv/pipx bin commands gone", "stat bins", "FAIL", str(leftovers))
        raise RuntimeError("uninstall left commands behind")
    h.record(number, "assert uv/pipx bin commands gone", "stat bins", "PASS")

    h.run(
        [
            "uv",
            "tool",
            "install",
            f"git+{export_uri}@{RELEASE_TAG}",
        ],
        title="reinstall uv tool @v1.0.0 for Stage C",
        timeout=300,
    )
    # Keep a handle to the inspected wheel name for the report (already done).
    _ = wheel


def stage_c(h: Harness) -> None:
    # 7. Clone + build post at v0.4.1 (no worktree registration in claimed repo).
    h.run(
        [
            "git",
            "clone",
            "--no-local",
            "--branch",
            POST_TAG,
            h.post_src.resolve().as_uri(),
            str(h.post_clone),
        ],
        title=f"git clone --no-local --branch {POST_TAG} post",
        timeout=300,
    )
    tip = h.run(
        ["git", "rev-parse", "HEAD"],
        title="git rev-parse HEAD (post clone)",
        cwd=h.post_clone,
    )
    clone_sha = (tip.stdout or "").strip()
    number = h.next_step("assert post clone HEAD == released SHA")
    print(f"$ test HEAD == {POST_RELEASE_SHA}", flush=True)
    if clone_sha != POST_RELEASE_SHA:
        h.record(
            number,
            "assert post clone HEAD == released SHA",
            "git rev-parse HEAD",
            "FAIL",
            f"got {clone_sha}",
        )
        raise RuntimeError(
            f"post clone HEAD {clone_sha} != released {POST_RELEASE_SHA}"
        )
    h.record(
        number,
        "assert post clone HEAD == released SHA",
        clone_sha,
        "PASS",
    )
    h.run(
        ["cargo", "build", "--release"],
        title="cargo build --release (post)",
        cwd=h.post_clone,
        timeout=900,
    )
    h.local_bin.mkdir(parents=True, exist_ok=True)
    # README cold-start install — use unlink (not rm) if a prior link exists.
    post_bin = h.local_bin / "post"
    number = h.next_step("install post binary into synthetic ~/.local/bin")
    print(f"$ install -m 0755 target/release/post {post_bin}", flush=True)
    if post_bin.exists() or post_bin.is_symlink():
        post_bin.unlink()
    subprocess.run(
        [
            "install",
            "-m",
            "0755",
            str(h.post_clone / "target" / "release" / "post"),
            str(post_bin),
        ],
        check=True,
        capture_output=True,
    )
    h.record(number, "install post binary into synthetic ~/.local/bin", "install", "PASS")

    h.room_dir.mkdir(parents=True, exist_ok=True)
    # Do NOT pre-create mail_root — post bootstraps rooms.json/rules.json on
    # first successful `rooms add`. An empty pre-created dir fails closed.
    env = h.base_env()
    # README cold-start six (rooms add, cd, send-to-self, join, inbox).
    h.run(
        ["post", "rooms", "add", OWNER_ROOM, str(h.room_dir)],
        title="post rooms add",
        env=env,
    )
    h.run(
        ["post", "send", "--to", OWNER_ROOM, "--body", "hello"],
        title="post send-to-self",
        cwd=h.room_dir,
        env=env,
    )
    h.run(
        ["post", "chat", CHANNEL, "--join"],
        title="post chat --join",
        cwd=h.room_dir,
        env=env,
    )
    h.run(
        ["post", "inbox"],
        title="post inbox",
        cwd=h.room_dir,
        env=env,
    )

    # 8. Ceremony order.
    porch = str(h.uv_bin / "porch")
    init_flags = [
        porch,
        "init",
        "--owner-room",
        OWNER_ROOM,
        "--owner-room-dir",
        str(h.room_dir),
        "--mail-root",
        str(h.mail_root),
        "--marker",
        OWNER_MARKER,
        "--label",
        OWNER_LABEL,
        "--initial-channel",
        CHANNEL,
    ]
    first = h.run(
        init_flags,
        title="porch init before post owner (expect stop + exact command)",
        cwd=h.room_dir,
        env=env,
        check=False,
        expect_rc=None,
    )
    # initcli InitError defaults to exit_code 1
    if first.returncode == 0:
        raise RuntimeError("porch init unexpectedly succeeded before post owner init")
    number = h.next_step("assert porch init printed exact post owner init command")
    blob = (first.stdout or "") + (first.stderr or "")
    print("$ parse post owner init command from porch init output", flush=True)
    try:
        owner_cmd = extract_owner_init_command(blob)
    except RuntimeError as exc:
        h.record(number, "assert printed post owner init command", "parse", "FAIL", str(exc))
        raise
    if "POST_MAIL_ROOT=" not in owner_cmd or "post owner init" not in owner_cmd:
        h.record(number, "assert printed post owner init command", owner_cmd, "FAIL")
        raise RuntimeError("printed command missing required pieces")
    h.record(number, "assert printed post owner init command", owner_cmd, "PASS")

    h.run(
        [],
        title="execute printed post owner init VERBATIM",
        cwd=h.room_dir,
        env=env,
        shell_command=owner_cmd,
    )
    h.run(
        init_flags,
        title="porch init after post owner (success)",
        cwd=h.room_dir,
        env=env,
    )
    h.run(
        init_flags,
        title="porch init idempotent rerun",
        cwd=h.room_dir,
        env=env,
    )
    conflict = h.run(
        [*init_flags, "--label", "OtherLabel"],
        title="porch init conflicting-field rerun (expect refuse)",
        cwd=h.room_dir,
        env=env,
        check=False,
    )
    number = h.next_step("assert conflicting-field refusal names the disagreement")
    cblob = (conflict.stdout or "") + (conflict.stderr or "")
    print("$ check refusal names disagreement", flush=True)
    if conflict.returncode == 0:
        h.record(number, "conflicting-field refusal", "porch init", "FAIL", "rc=0")
        raise RuntimeError("conflicting init should refuse")
    if "different values" not in cblob and "disagree" not in cblob:
        h.record(number, "conflicting-field refusal", cblob[:200], "FAIL")
        raise RuntimeError("refusal did not name the disagreement")
    h.record(number, "conflicting-field refusal", "named disagreement", "PASS")

    # 9. Parity + doctor negative only.
    show = h.run(
        ["post", "owner", "show", "--json"],
        title="post owner show parity",
        cwd=h.room_dir,
        env=env,
    )
    owner = json.loads(show.stdout)
    number = h.next_step("assert post owner show agrees with porch config fields")
    print("$ compare post owner show vs porch config.toml", flush=True)
    cfg_path = h.home / ".config" / "porch" / "config.toml"
    cfg_text = cfg_path.read_text(encoding="utf-8")
    o = owner.get("owner") or {}
    checks = [
        (o.get("room"), OWNER_ROOM),
        (o.get("marker"), OWNER_MARKER),
        (o.get("label"), OWNER_LABEL),
    ]
    bad = [f"{a!r}!={b!r}" for a, b in checks if a != b]
    if "owner_room" not in cfg_text or OWNER_ROOM not in cfg_text:
        bad.append("config missing owner_room")
    if bad:
        h.record(number, "parity post owner vs porch config", "compare", "FAIL", str(bad))
        raise RuntimeError("parity mismatch")
    h.record(number, "parity post owner vs porch config", "compare", "PASS")

    stub_dir = h.root / "post-stub"
    stub_dir.mkdir(parents=True, exist_ok=True)
    write_executable(
        stub_dir / "post",
        """#!/bin/sh
case "$1" in
  --version|-V) echo "post 0.0.0-version-only-stub"; exit 0 ;;
  *) echo "stub: no owner surface" >&2; exit 1 ;;
esac
""",
    )
    doctor_env = dict(env)
    doctor_env["PATH"] = os.pathsep.join(
        [str(stub_dir), *[p for p in env["PATH"].split(os.pathsep) if p != str(h.local_bin)]]
    )
    # Ensure real post is shadowed.
    doctor = h.run(
        [str(h.uv_bin / "porch-mobile"), "--state-root", str(h.state_root), "doctor"],
        title="doctor negative: version-only post stub fails closed",
        cwd=h.room_dir,
        env=doctor_env,
        check=False,
        expect_rc=1,
    )
    _ = doctor


def stage_d(h: Harness) -> tuple[str, str, str]:
    """Daemon, pairing, sends, DR. Returns (unsigned_id, signed_id, rc4_victim_id)."""
    install_shims(h)
    env = h.base_env()
    mobile = str(h.uv_bin / "porch-mobile")

    # 10. Setup via REAL installed command + foreground daemon.
    h.run(
        [
            mobile,
            "--state-root",
            str(h.state_root),
            "setup",
            "--port",
            str(h.port),
            "--base-url",
            PAIR_BASE,
        ],
        title="porch-mobile setup --base-url https://smoke.invalid",
        cwd=h.room_dir,
        env=env,
        timeout=60,
    )
    number = h.next_step("assert launchctl plist paths + tailscale targets")
    print("$ audit shim argv logs", flush=True)
    lc_lines = [
        json.loads(ln)
        for ln in h.launchctl_log.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    ts_lines = [
        json.loads(ln)
        for ln in h.tailscale_log.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    if not lc_lines or not ts_lines:
        h.record(
            number,
            "assert launchctl/tailscale isolation",
            f"lc={lc_lines} ts={ts_lines}",
            "FAIL",
            "expected nonempty shim call logs",
        )
        raise RuntimeError("shim logs empty")
    home_resolved = h.home.resolve()
    for argv in lc_lines:
        if not argv:
            h.record(
                number,
                "assert launchctl/tailscale isolation",
                str(argv),
                "FAIL",
                "empty launchctl argv",
            )
            raise RuntimeError("empty launchctl argv")
        if argv[0] == "list":
            if argv != ["list", LAUNCH_LABEL]:
                h.record(
                    number,
                    "assert launchctl/tailscale isolation",
                    str(argv),
                    "FAIL",
                    "unexpected launchctl list shape",
                )
                raise RuntimeError("launchctl list argv mismatch")
            continue
        if argv[0] in ("load", "unload") and len(argv) == 2 and argv[1].endswith(".plist"):
            try:
                Path(argv[1]).resolve().relative_to(home_resolved)
            except ValueError:
                h.record(
                    number,
                    "assert launchctl/tailscale isolation",
                    str(argv),
                    "FAIL",
                    f"plist outside HOME: {argv[1]}",
                )
                raise RuntimeError("launchctl plist escaped synthetic HOME") from None
            continue
        h.record(
            number,
            "assert launchctl/tailscale isolation",
            str(argv),
            "FAIL",
            "unexpected launchctl argv family",
        )
        raise RuntimeError(f"unexpected launchctl argv: {argv}")
    expected_serve = f"http://127.0.0.1:{h.port}"
    serve_targets = [
        argv[-1]
        for argv in ts_lines
        if argv == ["serve", "--bg", "--https=443", expected_serve]
    ]
    if not serve_targets or any(t != expected_serve for t in serve_targets):
        h.record(
            number,
            "assert launchctl/tailscale isolation",
            str(ts_lines),
            "FAIL",
            f"expected exact serve target {expected_serve}",
        )
        raise RuntimeError("tailscale serve target mismatch")
    h.record(number, "assert launchctl/tailscale isolation", "shim logs", "PASS")

    plist = h.home / "Library" / "LaunchAgents" / f"{LAUNCH_LABEL}.plist"
    cfg = h.state_root / "config.json"
    if not plist.is_file() or not cfg.is_file():
        raise RuntimeError("setup did not write plist/config")

    # Foreground daemon.
    number = h.next_step("start porch-mobile run (foreground daemon)")
    daemon_cmd = [
        mobile,
        "--state-root",
        str(h.state_root),
        "run",
    ]
    display = " ".join(shlex.quote(a) for a in daemon_cmd)
    print(f"$ {display} &", flush=True)
    h._daemon = subprocess.Popen(
        daemon_cmd,
        cwd=str(h.room_dir),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_for_port(h.port, timeout=45)
    except Exception:
        h.record(number, "start porch-mobile run", display, "FAIL", "port not open")
        raise
    h.record(number, "start porch-mobile run", display, "PASS", f"port {h.port}")

    host = urlparse(PAIR_BASE).netloc
    origin = PAIR_BASE
    number = h.next_step("static assets 200 with allowed Host; disallowed → 403")
    print("$ GET discovered static/* Host=smoke.invalid / evil.example", flush=True)
    if not h.static_urls:
        h.record(number, "static assets Host allow", "urls", "FAIL", "no discovered URLs")
        raise RuntimeError("stage_a did not discover static URLs")
    # Cover every wheel static member (+ / alias) — future assets cannot escape.
    static_paths = list(h.static_urls)
    if "/" not in static_paths:
        static_paths = ["/"] + static_paths
    for sp in static_paths:
        status = http_get_status(h.port, sp, host=host)
        if status != 200:
            h.record(number, "static assets Host allow", sp, "FAIL", f"status={status}")
            raise RuntimeError(f"static {sp} → {status}")
    bad = http_get_status(h.port, "/", host="evil.example")
    if bad != 403:
        h.record(number, "static assets Host allow", "evil.example", "FAIL", f"status={bad}")
        raise RuntimeError("disallowed Host did not 403")
    h.record(
        number,
        "static assets Host allow",
        f"allowed=200 ({len(static_paths)} urls) disallowed=403",
        "PASS",
    )

    # 11. Pair.
    pair_out = h.run(
        [mobile, "--state-root", str(h.state_root), "pair"],
        title="porch-mobile pair (mint token)",
        cwd=h.room_dir,
        env=env,
    )
    token = extract_pair_token((pair_out.stdout or "") + (pair_out.stderr or ""))
    number = h.next_step("POST /api/pair with allowed Host/Origin")
    print("$ POST /api/pair", flush=True)
    status, payload, hdrs = http_json(
        h.port,
        "POST",
        "/api/pair",
        body={"one_time_token": token},
        host=host,
        origin=origin,
    )
    if status != 200:
        h.record(number, "POST /api/pair", "/api/pair", "FAIL", f"status={status} {payload}")
        raise RuntimeError("pair failed")
    set_cookie = hdrs.get("Set-Cookie") or hdrs.get("set-cookie") or ""
    cookie = set_cookie.split(";", 1)[0]
    csrf = payload.get("csrf_secret")
    if not cookie or not csrf:
        h.record(number, "POST /api/pair", "/api/pair", "FAIL", "missing cookie/csrf")
        raise RuntimeError("pair missing cookie/csrf")
    h.record(number, "POST /api/pair", "/api/pair", "PASS")

    def send(draft: str, intent: str, attempt: str) -> tuple[int, dict]:
        return http_json(
            h.port,
            "POST",
            f"/api/channels/{CHANNEL}/send",
            body={
                "attempt_id": attempt,
                "draft_text": draft,
                "intent": intent,
            },
            host=host,
            origin=origin,
            cookie=cookie,
            csrf=csrf,
        )[:2]

    # 12. Unsigned send.
    st, unsigned = send("smoke unsigned hello", "unsigned", "u1")
    number = h.next_step("unsigned send delivered")
    print("$ POST send intent=unsigned", flush=True)
    if st != 200 or not unsigned.get("ok"):
        h.record(number, "unsigned send", str(unsigned), "FAIL", f"status={st}")
        raise RuntimeError("unsigned send failed")
    unsigned_id = unsigned.get("message_id")
    if not unsigned_id:
        h.record(number, "unsigned send", str(unsigned), "FAIL", "no message_id")
        raise RuntimeError("unsigned send missing id")
    h.record(number, "unsigned send", f"id={unsigned_id}", "PASS")

    peek_u = h.run(
        ["post", "chat", CHANNEL, "--peek"],
        title="post chat --peek (unsigned badge-free)",
        cwd=h.room_dir,
        env=env,
    )
    number = h.next_step("unsigned peek is badge-free (no VERIFIED)")
    peek_text = (peek_u.stdout or "") + (peek_u.stderr or "")
    if "VERIFIED" in peek_text:
        h.record(number, "unsigned peek badge-free", "peek", "FAIL", "VERIFIED present")
        raise RuntimeError("unsigned peek unexpectedly VERIFIED")
    h.record(number, "unsigned peek badge-free", "peek", "PASS")

    # 13. Signed send — dark first, then arm, then deliver + verify.
    st, dark = send("smoke signed body", "signed", "s-dark")
    number = h.next_step("signed intent while dark → signing_unavailable")
    print("$ POST send intent=signed (dark)", flush=True)
    err = (dark.get("error") or {}) if isinstance(dark, dict) else {}
    code = err.get("code") if isinstance(err, dict) else None
    clear_draft = dark.get("clear_draft") if isinstance(dark, dict) else None
    if clear_draft is None and isinstance(err, dict):
        clear_draft = err.get("clear_draft")
    if st != 409 or code != "signing_unavailable" or clear_draft is not False:
        h.record(
            number,
            "signed dark refuse",
            str(dark),
            "FAIL",
            f"status={st} code={code} clear_draft={clear_draft}",
        )
        raise RuntimeError(
            "expected HTTP 409 + error.code=signing_unavailable + clear_draft=false"
        )
    h.record(number, "signed dark refuse", "409 signing_unavailable clear_draft=false", "PASS")

    h.run(
        [mobile, "--state-root", str(h.state_root), "arm", "1h"],
        title="porch-mobile arm from owner-room cwd",
        cwd=h.room_dir,
        env=env,
    )
    st, signed = send("smoke signed body", "signed", "s1")
    number = h.next_step("signed send delivered after arm")
    print("$ POST send intent=signed (armed)", flush=True)
    if st != 200 or not signed.get("ok") or not signed.get("signed"):
        h.record(number, "signed send", str(signed), "FAIL", f"status={st}")
        raise RuntimeError("signed send failed")
    signed_id = signed.get("message_id")
    if not signed_id:
        h.record(number, "signed send", str(signed), "FAIL", "no message_id")
        raise RuntimeError("signed send missing id")
    h.record(number, "signed send", f"id={signed_id}", "PASS")

    h.run(
        [str(h.uv_bin / "porch-verify"), signed_id],
        title="porch-verify signed id → rc0",
        cwd=h.room_dir,
        env=env,
    )
    peek_s = h.run(
        ["post", "chat", CHANNEL, "--peek"],
        title="post chat --peek shows VERIFIED",
        cwd=h.room_dir,
        env=env,
    )
    number = h.next_step("signed peek renders VERIFIED")
    if "VERIFIED" not in ((peek_s.stdout or "") + (peek_s.stderr or "")):
        h.record(number, "signed peek VERIFIED", "peek", "FAIL")
        raise RuntimeError("signed peek missing VERIFIED")
    h.record(number, "signed peek VERIFIED", "peek", "PASS")

    # 14. DR: signed /decision then signed /accept; project via porch-dr.
    st, dec = send(f"/decision {unsigned_id} smoke-project harness title", "signed", "d1")
    number = h.next_step("signed /decision via API")
    print("$ POST /decision", flush=True)
    if st != 200 or not dec.get("ok") or dec.get("signed") is not True:
        h.record(number, "signed /decision", str(dec), "FAIL", f"status={st}")
        raise RuntimeError("decision send failed")
    dr_id = dec.get("dr_event")
    if not dr_id:
        h.record(number, "signed /decision", str(dec), "FAIL", "no dr_event")
        raise RuntimeError("decision missing dr_event")
    h.record(number, "signed /decision", f"dr={dr_id}", "PASS")

    st, acc = send(f"/accept {dr_id}", "signed", "a1")
    number = h.next_step("signed /accept via API")
    if st != 200 or not acc.get("ok") or acc.get("signed") is not True:
        h.record(number, "signed /accept", str(acc), "FAIL", f"status={st}")
        raise RuntimeError("accept send failed")
    h.record(number, "signed /accept", f"dr={dr_id}", "PASS")

    # DR ratification is observed when the service absorbs the accept message
    # (GET /messages → messages() → _observe_dr_actions). The poller alone
    # does not load message bodies.
    number = h.next_step("GET /messages to absorb accept → append ratified")
    print("$ GET /api/channels/commons/messages", flush=True)
    st_m, _payload_m, _ = http_json(
        h.port,
        "GET",
        f"/api/channels/{CHANNEL}/messages",
        host=host,
        origin=None,
        cookie=cookie,
        csrf=csrf,
    )
    if st_m != 200:
        h.record(number, "GET messages absorb accept", f"status={st_m}", "FAIL")
        raise RuntimeError("messages poll after accept failed")
    h.record(number, "GET messages absorb accept", f"status={st_m}", "PASS")

    show = h.run(
        [str(h.uv_bin / "porch-dr"), "show", dr_id],
        title="porch-dr show projection",
        cwd=h.room_dir,
        env=env,
    )
    number = h.next_step("porch-dr projection shows ratified")
    try:
        record = json.loads(show.stdout)
    except json.JSONDecodeError:
        record = {}
    if record.get("state") != "ratified":
        h.record(number, "porch-dr ratified", str(record), "FAIL")
        raise RuntimeError(f"expected ratified, got {record.get('state')!r}")
    h.record(number, "porch-dr ratified", dr_id, "PASS")

    # 14b. Final positive doctor.
    h.run(
        [mobile, "--state-root", str(h.state_root), "doctor"],
        title="porch-mobile doctor all-green (rc0)",
        cwd=h.room_dir,
        env=env,
    )

    # Mint a second signed message while cookie/CSRF are live — Stage E
    # tampers the first and verifies this victim with ssh-keygen absent.
    st, victim = send("rc4 victim", "signed", "s-rc4")
    number = h.next_step("mint signed rc4 victim while session live")
    print("$ POST send intent=signed (rc4 victim)", flush=True)
    if (
        isinstance(victim, dict)
        and victim.get("state") == "crossed"
        and victim.get("bounce_token")
    ):
        st, victim = http_json(
            h.port,
            "POST",
            f"/api/channels/{CHANNEL}/confirm",
            body={
                "confirm_attempt_id": "s-rc4-c",
                "bounce_token": victim["bounce_token"],
            },
            host=host,
            origin=origin,
            cookie=cookie,
            csrf=csrf,
        )[:2]
    if st != 200 or not victim.get("ok") or not victim.get("message_id"):
        h.record(number, "mint rc4 victim", str(victim), "FAIL", f"status={st}")
        raise RuntimeError(f"rc4 victim send failed: {victim}")
    victim_id = victim["message_id"]
    h.record(number, "mint rc4 victim", f"id={victim_id}", "PASS")

    return str(unsigned_id), str(signed_id), str(victim_id)


def stage_e(h: Harness, signed_id: str, victim_id: str) -> None:
    env = h.base_env()
    verify = str(h.uv_bin / "porch-verify")

    # rc1: tamper one byte of the stored message.
    msg_path = h.mail_root / "channels" / CHANNEL / "messages" / f"{signed_id}.msg"
    number = h.next_step("tamper one byte of stored signed message")
    print(f"$ mutate {msg_path}", flush=True)
    if not msg_path.is_file():
        h.record(number, "tamper message", str(msg_path), "FAIL", "missing")
        raise RuntimeError("signed message file missing")
    data = bytearray(msg_path.read_bytes())
    if not data:
        raise RuntimeError("empty message file")
    data[0] = (data[0] + 1) % 256
    msg_path.write_bytes(bytes(data))
    h.record(number, "tamper message", str(msg_path), "PASS")

    h.run(
        [verify, signed_id],
        title="porch-verify tampered → rc1",
        cwd=h.room_dir,
        env=env,
        expect_rc=1,
        check=True,
    )

    # rc2: malformed invocation.
    h.run(
        [verify],
        title="porch-verify no args → rc2",
        cwd=h.room_dir,
        env=env,
        expect_rc=2,
    )
    bogus_cfg = h.root / "not-a-config-file"
    # Ensure it exists as a directory (non-file) so load fails as usage/config.
    bogus_cfg.mkdir(parents=True, exist_ok=True)
    h.run(
        [verify, "--config", str(bogus_cfg), signed_id],
        title="porch-verify config pointing at non-file → rc2",
        cwd=h.room_dir,
        env=env,
        expect_rc=2,
    )

    # rc3: absent id.
    h.run(
        [verify, "20990101-000000-000000-aaaaaa"],
        title="porch-verify absent id → rc3",
        cwd=h.room_dir,
        env=env,
        expect_rc=3,
    )

    # rc4: PATH stripped of ssh-keygen (post still present for crosscheck).
    path4 = h.root / "path-no-ssh-keygen"
    path4.mkdir(parents=True, exist_ok=True)
    real_post = h.local_bin / "post"
    os.symlink(real_post, path4 / "post")
    env4 = dict(env)
    env4["PATH"] = str(path4)

    h.run(
        [verify, victim_id],
        title="porch-verify without ssh-keygen on PATH → rc4",
        cwd=h.room_dir,
        env=env4,
        expect_rc=4,
    )


def print_report(h: Harness) -> None:
    print("\n" + "=" * 72)
    print("B6a clean-home smoke report")
    print("=" * 72)
    print("Tool versions:")
    for name, ver in h.versions.items():
        print(f"  {name}: {ver}")
    print(f"  release tag: {RELEASE_TAG}")
    print(f"  post tag: {POST_TAG}")
    print(f"  port: {h.port}")
    print(f"  temp root: {h.root}")
    print()
    print(f"{'#':<4} {'STATUS':<6} {'STEP'}")
    for r in h.results:
        print(f"{r.number:<4} {r.status:<6} {r.title}")
        print(f"     cmd: {r.command}")
        if r.detail:
            print(f"     detail: {r.detail}")
    print()
    print("launchctl argv log:")
    print(h.launchctl_log.read_text(encoding="utf-8") if h.launchctl_log.exists() else "(none)")
    print("tailscale argv log:")
    print(h.tailscale_log.read_text(encoding="utf-8") if h.tailscale_log.exists() else "(none)")


def stop_daemon(h: Harness) -> None:
    if h._daemon is None:
        return
    proc = h._daemon
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    h._daemon = None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--post-src",
        default=None,
        help="path to the post source checkout (tag v0.4.1). "
        "Default: $PORCH_SMOKE_POST_CHECKOUT or sibling ../post",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="preserve the temp tree even on success",
    )
    args = parser.parse_args(argv)

    if sys.platform != "darwin":
        print("B6a clean-home smoke requires macOS", file=sys.stderr)
        return 2

    real_home = Path.home().resolve()
    post_src = resolve_post_src(args.post_src)
    # Keep the tree short: ssh-agent AF_UNIX sockets under state/agent/<id>/agent.sock
    # must fit macOS's ~104-byte sun_path limit.
    root = Path(tempfile.mkdtemp(prefix="pch-", dir="/tmp"))
    home = root / "home"
    home.mkdir()
    h = Harness(
        root=root,
        real_home=real_home,
        home=home,
        post_src=post_src,
        port=free_port(),
    )
    # Pre-create pinned roots so resolve checks pass before mkdir races.
    # Exception: POST_MAIL_ROOT / mail_root — leave absent so `post rooms add`
    # can bootstrap rooms.json (empty dir ⇒ config_invalid).
    for path in (
        h.state_root,
        h.uv_tool_dir,
        h.uv_bin,
        h.pipx_home,
        h.pipx_bin,
        h.local_bin,
        h.shim_dir,
    ):
        path.mkdir(parents=True, exist_ok=True)
    h.assert_isolation()
    tool_versions(h)

    print(f"temp root: {root}", flush=True)
    print(f"synthetic HOME: {home}", flush=True)
    print(f"post src: {post_src}", flush=True)
    print(f"isolated port: {h.port}", flush=True)

    ok = False
    try:
        wheel = stage_a(h)
        stage_b(h, wheel)
        stage_c(h)
        _unsigned_id, signed_id, victim_id = stage_d(h)
        stage_e(h, signed_id, victim_id)
        ok = True
    except Exception as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr, flush=True)
        ok = False
    finally:
        stop_daemon(h)
        print_report(h)

    if ok and not args.keep:
        # shutil.rmtree ONLY on success — never shell out to rm.
        shutil.rmtree(root, ignore_errors=False)
        print(f"\nPASS: cleaned temp tree {root}", flush=True)
        return 0

    print(f"\n{'PASS' if ok else 'FAIL'}: preserved temp tree for autopsy: {root}", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
