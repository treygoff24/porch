"""Server-authored send policy (§4, §7): slash dispatch and wire assembly.

The client sends content, never policy. Everything that decides what bytes
reach the channel — exact-first-token dispatch, the `/vote` transform, DR
instrument composition, attachment paths — happens here, on the Mac.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from porch3 import drstore
from porch3.commands import vote_text
from porchd import canonical

# Commands that exist in the TUI but are not sends. Refusing them with a
# pointer to the phone affordance beats broadcasting `/save` as a message.
NON_SEND_COMMANDS = {
    "/quit": "the phone has no session to quit — just close the tab",
    "/q": "the phone has no session to quit — just close the tab",
    "/copy": "long-press a message to copy it",
    "/save": "use the transcript download",
    "/seen": "open a message's detail for its seen-by list",
    "/dr": "open the DR screen",
    "/img": "use the attach button — the browser never handles machine paths",
}

DR_AUTHORITY_COMMANDS = {"/accept", "/reject", "/supersede"}


@dataclass
class Refusal:
    code: str
    message: str


@dataclass
class Wire:
    body: str
    draft_hash: str
    wire_hash: str
    kind: str = "chat"
    dr_event: dict | None = None
    notes: list[str] = field(default_factory=list)


def draft_hash(draft_text: str, attachments: list[str]) -> str:
    return canonical.digest({"draft_text": draft_text, "attachments": list(attachments)})


def wire_hash(body: str) -> str:
    return canonical.digest({"wire_body": body})


def make_wire(body: str, *, draft_text: str, attachments: list[str], spool_paths: list[str],
              kind: str = "chat", dr_event: dict | None = None) -> Wire:
    full = body
    if spool_paths:
        full = (body + "\n" + "\n".join(spool_paths)).strip("\n")
    return Wire(
        body=full,
        draft_hash=draft_hash(draft_text, attachments),
        wire_hash=wire_hash(full),
        kind=kind,
        dr_event=dr_event,
    )


def dispatch(
    draft_text: str,
    *,
    channel: str,
    attachments: list[str],
    spool_paths: list[str],
    intent: str,
    armed: bool,
    messages: list[dict],
    dr_records: dict[str, dict],
    dr_log_path=None,
) -> Wire | Refusal:
    """Turn a raw draft into the exact wire body, or refuse it.

    Dispatch is **exact first-token equality**. A `startswith` check was a
    real security bug in the TUI (`/votex choice` reached `/vote` and
    broadcast as the owner), and the phone must not reintroduce it.
    """
    raw = draft_text or ""
    text = raw.strip()
    if not text:
        return Refusal("empty_draft", "nothing to send")

    first = text.split()[0]
    arg = text[len(first):].strip()

    if not first.startswith("/"):
        return make_wire(raw, draft_text=draft_text, attachments=attachments,
                         spool_paths=spool_paths)

    if first in NON_SEND_COMMANDS:
        return Refusal("command_not_a_send", f"{first} is not a send — {NON_SEND_COMMANDS[first]}")

    if first == "/vote":
        ballot, err = vote_text(arg)
        if err or ballot is None:
            return Refusal("bad_command_args", err or "usage: /vote <poll-id> <choice>")
        return make_wire(ballot, draft_text=draft_text, attachments=attachments,
                         spool_paths=spool_paths, kind="vote")

    if first == "/decision":
        return _decision(text, channel=channel, draft_text=draft_text,
                         attachments=attachments, spool_paths=spool_paths,
                         messages=messages, dr_log_path=dr_log_path)

    if first in DR_AUTHORITY_COMMANDS:
        # An unsigned ⚖️ message is theater (§3): refuse before composing.
        if intent != "signed":
            return Refusal(
                "dr_requires_signing",
                f"{first} is an authority action — send it with signing on",
            )
        if not armed:
            return Refusal("signing_unavailable", "signing is dark — arm the lease at the Mac")
        return _dr_authority(first, text, draft_text=draft_text, attachments=attachments,
                             spool_paths=spool_paths, dr_records=dr_records)

    return Refusal("unknown_command", f"unknown command {first} (draft kept)")


def _decision(text: str, *, channel: str, draft_text: str, attachments: list[str],
              spool_paths: list[str], messages: list[dict], dr_log_path) -> Wire | Refusal:
    parts = text.split()
    if len(parts) < 3:
        return Refusal("bad_command_args", "usage: /decision <msg-prefix> <project> [title]")
    prefix, project = parts[1], parts[2]
    matches = [m for m in messages if m["id"].startswith(prefix)]
    if not matches:
        return Refusal("dr_no_anchor", f"no message here matching {prefix}")
    if len(matches) > 1:
        return Refusal(
            "dr_ambiguous_anchor",
            f"{len(matches)} messages match '{prefix}' — use a longer prefix",
        )
    anchor = matches[0]
    title = " ".join(parts[3:]) or ((anchor.get("body") or "")[:60].strip() or anchor["id"])
    # Authority never derives from titles, but a derived title must not
    # smuggle newlines or action glyphs into an owner-signed offer.
    title = " ".join(title.replace("⚖", " ").split())
    try:
        event = drstore.propose(
            title=title,
            project=project,
            channel=channel,
            anchor_message_id=anchor["id"],
            path=dr_log_path,
        )
    except (OSError, ValueError) as exc:
        return Refusal("dr_propose_failed", f"DR error: {exc}")
    body = drstore.offer_line({"dr": event["dr"], "title": title, "project": project})
    return make_wire(body, draft_text=draft_text, attachments=attachments,
                     spool_paths=spool_paths, kind="dr_offer", dr_event=event)


def _dr_authority(first: str, text: str, *, draft_text: str, attachments: list[str],
                  spool_paths: list[str], dr_records: dict[str, dict]) -> Wire | Refusal:
    parts = text.split()
    if first in ("/accept", "/reject"):
        if len(parts) != 2:
            return Refusal("bad_command_args", f"usage: {first} <dr-id>")
        dr = parts[1]
        record = dr_records.get(dr)
        if record is None:
            return Refusal("dr_unknown", f"no such record {dr}")
        if record["state"] != "needs_operator_decision":
            return Refusal("dr_settled", f"{dr} is already {record['state']}")
        verb = "accepted" if first == "/accept" else "rejected"
        return make_wire(f"⚖️ DR {dr} {verb}", draft_text=draft_text,
                         attachments=attachments, spool_paths=spool_paths, kind="dr_action")

    if len(parts) != 3:
        return Refusal("bad_command_args", "usage: /supersede <old-dr> <new-dr>")
    old, new = parts[1], parts[2]
    old_rec, new_rec = dr_records.get(old), dr_records.get(new)
    # Mirror the projection rule so the owner never signs a supersede that
    # projection will silently ignore.
    if old_rec is None or new_rec is None:
        return Refusal("dr_unknown", "both records must exist")
    if old == new:
        return Refusal("dr_invalid_supersede", "a record cannot supersede itself")
    if old_rec["state"] != "ratified":
        return Refusal("dr_invalid_supersede",
                       f"{old} must be ratified to supersede (is {old_rec['state']})")
    if new_rec["state"] != "ratified":
        return Refusal("dr_invalid_supersede",
                       f"{new} must be ratified to replace (is {new_rec['state']})")
    return make_wire(f"⚖️ DR {old} superseded by {new}", draft_text=draft_text,
                     attachments=attachments, spool_paths=spool_paths, kind="dr_action")
