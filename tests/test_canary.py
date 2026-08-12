"""Public-export canary: scan the committed SHIP blobs, not this checkout.

Runs in both trees. In the private parent, the SHIP manifest names the
export subset. In the public export the manifest deliberately does not
ship, and every tracked file IS the ship set, so the scan falls back to
`git ls-tree` — self-contained, no private inputs.
"""

from __future__ import annotations

import struct
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHIP = "docs/plans/manifest-ship.txt"
PATTERNS = "tests/canary.txt"
WAIVERS = "tests/canary-waivers.txt"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_TEXT_CHUNKS = {b"tEXt", b"iTXt", b"zTXt"}


def _blob(path: str) -> bytes:
    return subprocess.run(
        ["git", "show", f"HEAD:{path}"], cwd=ROOT, check=True,
        capture_output=True,
    ).stdout


def _ship_paths() -> list[str]:
    tracked = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD"], cwd=ROOT,
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if SHIP in tracked:
        ship = _blob(SHIP).decode().splitlines()
    else:
        ship = tracked
    # The canary control files must themselves be part of the artifact:
    # a ledger that could silently stay home proves nothing.
    for control in (PATTERNS, WAIVERS):
        assert control in ship, f"canary control file not shipped: {control}"
        assert control in tracked, f"canary control file not tracked: {control}"
    return ship


def _waivers(patterns: set[str]) -> dict[tuple[str, str], str]:
    rows: dict[tuple[str, str], str] = {}
    for line in _blob(WAIVERS).decode().splitlines():
        path, pattern, reason = line.split("\t")
        assert path and pattern in patterns and reason
        assert (path, pattern) not in rows, f"duplicate waiver: {path} {pattern}"
        rows[path, pattern] = reason
    return rows


def _png_chunks(data: bytes) -> list[bytes]:
    assert data.startswith(PNG_SIGNATURE)
    pos, chunks = len(PNG_SIGNATURE), []
    while pos < len(data):
        size = struct.unpack(">I", data[pos : pos + 4])[0]
        chunk = data[pos + 4 : pos + 8]
        chunks.append(chunk)
        pos += 12 + size
    assert pos == len(data)
    return chunks


def test_committed_ship_tree_has_no_unwaived_canaries():
    ship = _ship_paths()
    patterns = _blob(PATTERNS).decode().splitlines()
    waivers = _waivers(set(patterns))
    used: set[tuple[str, str]] = set()
    with tempfile.TemporaryDirectory() as temp:
        export = Path(temp)
        pattern_file = export / PATTERNS
        text_files: list[Path] = []
        png_files: list[Path] = []
        for rel in ship:
            path = export / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            data = _blob(rel)
            path.write_bytes(data)
            if path.suffix == ".png":
                png_files.append(path)
            elif b"\0" not in data:
                data.decode("utf-8")
                text_files.append(path)
            else:
                raise AssertionError(f"unclassified binary SHIP file: {rel}")

        assert pattern_file.is_file()
        failures = []
        for pattern in patterns:
            result = subprocess.run(
                ["rg", "--files-with-matches", "-e", pattern, *text_files],
                cwd=export, text=True, capture_output=True,
            )
            assert result.returncode in (0, 1), result.stderr
            for found in result.stdout.splitlines():
                rel = str(Path(found).relative_to(export))
                key = rel, pattern
                if key in waivers:
                    used.add(key)
                else:
                    failures.append(key)

        for path in png_files:
            rel = str(path.relative_to(export))
            assert not (set(_png_chunks(path.read_bytes())) & PNG_TEXT_CHUNKS), rel
            strings = subprocess.run(
                ["strings", str(path)], check=True, text=True, capture_output=True,
            ).stdout
            result = subprocess.run(
                ["rg", "--files-with-matches", "-f", pattern_file, "-"],
                input=strings, text=True, capture_output=True,
            )
            assert result.returncode == 1, f"binary canary hit: {rel}"

    assert not failures, f"unwaived canaries: {failures}"
    assert used == set(waivers), f"unused waivers: {sorted(set(waivers) - used)}"
