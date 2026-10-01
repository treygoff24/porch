"""Regenerate public test evidence. This key is intentionally committed and never trusted live."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
KEY = ROOT / "test-key"
env = {key: value for key, value in os.environ.items() if key not in {"SSH_AUTH_SOCK", "SSH_AGENT_PID"}}
body = "  first\r\n\x1b[31mESC\x85C1\u202eBIDI\t \n🦊🔏 bait [signed:NOT-A-REF]\nlast\t \r\n"

def write_signed(tag, payload):
    path = ROOT / f"{tag}.txt"
    path.write_bytes(payload)
    os.chmod(path, 0o600)
    signed = subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(KEY), "-n", "mara-porch"], input=payload, check=True, env=env, capture_output=True)
    (ROOT / f"{tag}.txt.sig").write_bytes(signed.stdout)

def manifest(tag, channel, text):
    data = text.encode("utf-8")
    return f"porch-signed-v2\ntag: {tag}\nchannel: {channel}\nbytes: {len(data)}\nsha256: {hashlib.sha256(data).hexdigest()}\n".encode()

v2 = "20260930T230000Z"
v1 = "20260930T230001Z"
wrong = "20260930T230002Z"
write_signed(v2, manifest(v2, "commons", body))
write_signed(v1, f"{v1}\nhello golden\n".encode())
write_signed(wrong, manifest(wrong, "elsewhere", body))
base = {"id": "20260930-230000-000001-abcdef", "from": "mara", "channel": "commons", "sent": "2026-09-30 23:00:00 +0000", "body": body, "signature_ref": {"version": 2, "tag": v2}, "future_field": {"kept": True}}
cases = [{"name": "raw-controls-crlf-trailing-space", "expected": "verified", "record": base}]
cases.append({"name": "signed-v1", "expected": "verified", "record": {**base, "body": f"🦊🔏 hello golden [signed:{v1}]", "signature_ref": "OMIT"}})
for name, locator in [("locator-null", None), ("missing-tag", {"version": 2}), ("tag-grammar", {"version": 2, "tag": "bad/tag"}), ("version-three", {"version": 3, "tag": v2}), ("boolean-version", {"version": True, "tag": v2}), ("extra-locator-key", {"version": 2, "tag": v2, "extra": 1})]:
    cases.append({"name": name, "expected": "failed", "record": {**base, "signature_ref": locator}})
cases.extend([
    {"name": "envelope-channel-mismatch", "expected": "failed", "record": {**base, "channel": "elsewhere"}},
    {"name": "manifest-channel-mismatch", "expected": "failed", "record": {**base, "signature_ref": {"version": 2, "tag": wrong}}},
    {"name": "incomplete-body", "expected": "unknown", "record": {**base, "body_complete": False}},
    {"name": "body-mutated", "expected": "failed", "record": {**base, "body": body + "!"}},
    {"name": "non-owner", "expected": "failed", "record": {**base, "from": "agent"}},
])
for case in cases:
    if case["record"].get("signature_ref") == "OMIT":
        del case["record"]["signature_ref"]
(ROOT / "records.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
(ROOT / "allowed_signers").write_text('mara@porch namespaces="mara-porch" ' + (ROOT / "test-key.pub").read_text().strip() + "\n")
