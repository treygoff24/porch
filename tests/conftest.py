"""Shared fixtures for the porchd (porch-mobile server) tests.

Nothing here touches the real mail corpus, the real state root, or the
network: channels are built in a tmp dir and every subprocess boundary
(post, porch-verify, ssh-add) is patched at its import site.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from porch3.config import PorchConfig
from helpers import make_porch_config

SENT = "2025-01-10 18:47:42 -0500"


def make_id(seq: int) -> str:
    return f"20250110-1847{seq:02d}-000000-{seq:06x}"



@pytest.fixture
def porch_config(tmp_path) -> PorchConfig:
    return make_porch_config(tmp_path)


@pytest.fixture
def channels_root(tmp_path):
    root = tmp_path / "channels"
    for channel in ("commons", "backporch"):
        (root / channel / "messages").mkdir(parents=True)
        (root / channel / "channel.json").write_text(
            json.dumps({"description": f"the {channel}"})
        )
        (root / channel / "members.json").write_text(
            json.dumps({"mara": SENT, "finch": SENT})
        )
    return root


@pytest.fixture
def add_msg(channels_root):
    def _add(channel: str, seq: int, sender: str, body: str, **meta):
        mid = meta.pop("mid", None) or make_id(seq)
        head = {"id": mid, "from": sender, "channel": channel, "sent": SENT, **meta}
        path = channels_root / channel / "messages" / f"{mid}.msg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(head) + "\n---\n" + body)
        return mid

    return _add


@pytest.fixture
def joins():
    return []


@pytest.fixture
def svc(tmp_path, channels_root, joins, porch_config, monkeypatch):
    from porch3 import drstore
    from porchd import config as config_mod
    from porchd import lease
    from porchd import service as service_mod

    state_root = tmp_path / "state"
    monkeypatch.setenv("PORCHD_STATE_ROOT", str(state_root))
    monkeypatch.setattr(drstore, "DR_LOG_PATH", tmp_path / "decision-records.jsonl")
    monkeypatch.setattr(drstore, "MAIL_ROOT", tmp_path / "mail")
    monkeypatch.setattr(
        service_mod,
        "registered_rooms",
        lambda *a, **k: frozenset({"mara", "finch", "juniper"}),
    )
    monkeypatch.setattr(
        service_mod, "fetch_presence", lambda *a, **k: {"finch": True}
    )
    monkeypatch.setattr(service_mod, "enqueue_verifications", lambda msgs, **kw: None)
    monkeypatch.setattr(
        service_mod,
        "join_channel",
        lambda channel, config=None, **kw: (joins.append(channel), True)[1],
    )
    monkeypatch.setattr(lease, "is_armed", lambda root: False)
    monkeypatch.setattr(
        lease,
        "status",
        lambda root: {
            "armed": False,
            "deadline": None,
            "deadline_utc": None,
            "socket_present": False,
        },
    )
    # Tests never have a live post profile for the synthetic room dir.
    monkeypatch.setattr(
        "porch3.roomcheck.assert_acting_room", lambda config: None
    )
    monkeypatch.setattr(
        "porch3.roomcheck.apply_owner_crosscheck", lambda config: config
    )

    service = service_mod.Service(
        state_root,
        porch_config=porch_config,
        channels_root=channels_root,
        config=config_mod.Config(port=8765, hostname="mac.example.ts.net"),
        spool_dir=tmp_path / "spool",
    )
    service.start(with_agent=False, with_poller=False)
    return service


@pytest.fixture
def ok_send(monkeypatch):
    """Patch the unsigned send path; returns the list of calls made."""
    from porch3.send import SendResult
    from porchd import service as service_mod

    calls = []

    def _fake(channel, text, *, raw=False, anyway=False, config=None):
        calls.append({"channel": channel, "text": text, "anyway": anyway})
        return SendResult(
            ok=True,
            message="sent",
            raw={"message": {"id": make_id(90 + len(calls))}},
        )

    monkeypatch.setattr(service_mod, "send_as_owner", _fake)
    return calls
