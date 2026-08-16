"""B0 acceptance tests — required integration classes."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from helpers import make_porch_config
from porch3.config import build_config, emit_toml, legacy_hardcoded_values
from porch3.wire import DEFAULT_MARKER, DEFAULT_WIRE, compile_wire



class TestTwoConfigsOneProcess:
    """Delegate F5: two PorchConfigs in one process — no captured-global leakage."""

    def test_two_configs_do_not_share_paths(self, tmp_path):
        a = make_porch_config(tmp_path / "a", owner_room="mara")
        b = make_porch_config(tmp_path / "b", owner_room="river", marker="🐉")
        assert a.owner_room_dir != b.owner_room_dir
        assert a.mail_root != b.mail_root
        assert a.key_file != b.key_file
        assert a.wire.marker != b.wire.marker
        # lease.arm requires explicit key — no module KEY to leak between them
        from porchd import lease

        assert "KEY" not in lease.__dict__ or not hasattr(lease, "KEY")


def _owner_show_json(cfg, **owner_overrides) -> dict:
    """Ratified A0b ``post owner show`` shape (nested owner object)."""
    owner = {
        "room": cfg.owner_room,
        "sidecar_dir": str(cfg.sidecar_dir),
        "allowed_signers": str(cfg.allowed_signers),
        "principal": cfg.principal,
        "namespace": cfg.signing_namespace,
        "marker": cfg.marker,
        "label": cfg.label,
    }
    owner.update(owner_overrides)
    return {"ok": True, "state": "configured", "owner": owner}


def _profile_show_json(room: str) -> dict:
    return {"ok": True, "room": room, "profile": {}}


class TestFailClosedRoomInvariant:
    """F7: mismatched room dir ↔ room name fails closed pre-join."""

    def test_name_valid_wrong_dir_fails(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        room_dir = tmp_path / "wrong-room"
        room_dir.mkdir()
        cfg = build_config(
            owner_room="mara",
            owner_room_dir=room_dir,
            mail_root=tmp_path / "mail",
            env={},
        )

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = __import__("json").dumps(_profile_show_json("other"))
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        with pytest.raises(roomcheck.RoomInvariantError) as ei:
            roomcheck.assert_acting_room(cfg)
        assert "mara" in str(ei.value)
        assert "other" in str(ei.value)

    def test_nonzero_exit_refuses_json_tail(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        room_dir = tmp_path / "room"
        room_dir.mkdir()
        cfg = build_config(
            owner_room="mara",
            owner_room_dir=room_dir,
            mail_root=tmp_path / "mail",
            env={},
        )

        def fake_run(*args, **kwargs):
            class R:
                returncode = 1
                stdout = 'noise {"ok": true, "room": "mara", "profile": {}}'
                stderr = "boom"

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        with pytest.raises(roomcheck.RoomInvariantError) as ei:
            roomcheck.assert_acting_room(cfg)
        assert "exited 1" in str(ei.value)

    def test_profile_show_requires_ok_and_exact_schema(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        room_dir = tmp_path / "room"
        room_dir.mkdir()
        cfg = build_config(
            owner_room="mara",
            owner_room_dir=room_dir,
            mail_root=tmp_path / "mail",
            env={},
        )

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = '{"room": "mara"}'
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        with pytest.raises(roomcheck.RoomInvariantError) as ei:
            roomcheck.assert_acting_room(cfg)
        assert "missing required keys" in str(ei.value)


class TestOwnerCrosscheck:
    """Runtime owner-field crosscheck disables sign+verify on mismatch."""

    def _owner_payload(self, cfg, **overrides):
        return _owner_show_json(cfg, **overrides)

    def test_agreement_leaves_signing_enabled(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara", marker="🦊", label="Mara")

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = __import__("json").dumps(self._owner_payload(cfg))
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        out = roomcheck.apply_owner_crosscheck(cfg)
        assert out.signing_disabled is False

    def test_field_mismatch_disables_sign_and_verify(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara", marker="🦊", label="Mara")
        payload = self._owner_payload(cfg, label="Other")

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = __import__("json").dumps(payload)
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        out = roomcheck.apply_owner_crosscheck(cfg)
        assert out.signing_disabled is True
        assert "label" in (out.signing_disabled_reason or "")

    def test_room_mismatch_hard_stops(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara")
        payload = self._owner_payload(cfg, room="other")

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = __import__("json").dumps(payload)
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        with pytest.raises(roomcheck.RoomInvariantError):
            roomcheck.apply_owner_crosscheck(cfg)

    def test_provisional_top_level_schema_disables(self, tmp_path, monkeypatch):
        """Invented top-level owner fields (pre-A0b fake) must not parse as configured."""
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara")

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = __import__("json").dumps(
                    {
                        "ok": True,
                        "configured": True,
                        "room": cfg.owner_room,
                        "sidecar_dir": str(cfg.sidecar_dir),
                        "allowed_signers": str(cfg.allowed_signers),
                        "principal": cfg.principal,
                        "namespace": cfg.signing_namespace,
                        "marker": cfg.marker,
                        "label": cfg.label,
                    }
                )
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        out = roomcheck.apply_owner_crosscheck(cfg)
        assert out.signing_disabled is True

    def test_legacy_state_disables(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara")
        payload = self._owner_payload(cfg)
        payload["state"] = "legacy"

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = __import__("json").dumps(payload)
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        out = roomcheck.apply_owner_crosscheck(cfg)
        assert out.signing_disabled is True
        assert "legacy" in (out.signing_disabled_reason or "")

    def test_schema_failure_disables_signing(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara")

        def fake_run(*args, **kwargs):
            class R:
                returncode = 0
                stdout = '{"ok": true, "state": "configured"}'
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        out = roomcheck.apply_owner_crosscheck(cfg)
        assert out.signing_disabled is True
        assert "owner" in (out.signing_disabled_reason or "").lower()

    def test_nonzero_exit_disables_signing(self, tmp_path, monkeypatch):
        from porch3 import roomcheck

        cfg = make_porch_config(tmp_path, owner_room="mara")

        def fake_run(*args, **kwargs):
            class R:
                returncode = 2
                stdout = __import__("json").dumps(self._owner_payload(cfg))
                stderr = ""

            return R()

        monkeypatch.setattr(roomcheck.subprocess, "run", fake_run)
        out = roomcheck.apply_owner_crosscheck(cfg)
        assert out.signing_disabled is True
        assert "exited 2" in (out.signing_disabled_reason or "")


class TestMailRootThreeWayMatrix:
    """Split-brain: config field > POST_MAIL_ROOT env > default."""

    def test_three_way_precedence(self, tmp_path, monkeypatch):
        from porch3.config import resolve_mail_root

        explicit = tmp_path / "explicit"
        env_root = tmp_path / "env"
        monkeypatch.setenv("POST_MAIL_ROOT", str(env_root))
        assert resolve_mail_root(explicit, env=os.environ) == explicit
        assert resolve_mail_root(None, env={"POST_MAIL_ROOT": str(env_root)}) == env_root
        assert resolve_mail_root(None, env={}) == Path.home() / ".claude-mail"

    def test_post_env_pins_resolved_root(self, tmp_path):
        cfg = make_porch_config(tmp_path)
        env = cfg.post_env({"PATH": "/usr/bin", "POST_MAIL_ROOT": "/tmp/wrong"})
        assert env["POST_MAIL_ROOT"] == str(cfg.mail_root)


class TestDenylistFollowsRoom:
    """Security: reveal denylist follows owner_room_dir."""

    def test_moved_room_is_denied(self, tmp_path):
        from porchd.imagesvc import reveal_denylist

        room_a = tmp_path / "room-a"
        room_b = tmp_path / "room-b"
        mail = tmp_path / "mail"
        for p in (room_a, room_b, mail):
            p.mkdir()
        denied = reveal_denylist(owner_room_dir=room_b, mail_root=mail)
        assert room_b.resolve() in {d.resolve() for d in denied}
        assert room_a.resolve() not in {d.resolve() for d in denied}


class TestWireRoundTripNonDefaultMarker:
    """Send → parse → badge → DR regex all through wire.py."""

    def test_non_default_marker_round_trip(self):
        w = compile_wire("🐉")
        text = "authority check"
        signed = w.prefix_signed(text, "20250111T120000Z")
        assert w.strip(signed) == text
        assert w.is_signed(signed)
        assert w.channel_text_for_verify(signed, "20250111T120000Z") == text
        body = f"{w.signed_prefix}⚖️ DR dr-7 accepted [signed:20250111T120000Z]"
        from porch3.drstore import parse_action_body

        parsed = parse_action_body(body, wire=w)
        assert parsed == ("dr-7", "accepted", None)
        # Default wire must NOT parse a foreign marker body.
        assert parse_action_body(body, wire=DEFAULT_WIRE) is None

    def test_integration_send_queue_badge_own_dr(self, tmp_path):
        """Non-default marker flows through enqueue → badge → own → DR."""
        from porch3.drstore import parse_action_body
        from porch3.store import clean_body
        from porch3.verify import (
            VERIFY_CACHE,
            apply_verify_result,
            enqueue_verifications,
            verified_owner,
            verify_badge,
        )
        from porchd.ownership import LiveVerifier

        cfg = make_porch_config(
            tmp_path, owner_room="mara", marker="🐉", label="Mara"
        )
        wire = cfg.wire
        tag = "20250111T150000Z"
        body = wire.prefix_signed("⚖️ DR dr-3 accepted", tag)
        msg = {"id": "20250111-fox-own", "from": "mara", "body": body}

        # Default wire must not recognize this as signed.
        enqueue_verifications([msg])  # defaults to DEFAULT_WIRE
        assert msg["id"] not in VERIFY_CACHE

        enqueue_verifications([msg], wire=wire)
        # Worker may or may not run; seed the positive cache as the worker would.
        apply_verify_result(msg["id"], " 🔏✓")
        assert verify_badge(msg, wire=wire) == " 🔏✓"
        assert verified_owner(msg, wire=wire) is True
        assert verify_badge(msg) == ""  # default wire: not signed
        assert verified_owner(msg) is False

        assert clean_body(body, wire=wire) == "⚖️ DR dr-3 accepted"
        assert parse_action_body(body, wire=wire) == ("dr-3", "accepted", None)

        verifier = LiveVerifier(channels_root=cfg.channels_dir, wire=wire)
        # consider queues; verify_now needs a file — write one and stub porch-verify.
        store = cfg.channels_dir / "commons" / "messages"
        store.mkdir(parents=True)
        (store / f"{msg['id']}.msg").write_text(
            '{"id":"%s","from":"mara"}\n---\n%s' % (msg["id"], body)
        )
        # Without a live porch-verify, consider still queues only signed msgs.
        before = set(verifier._queued) | set(verifier._verdicts)
        verifier.consider("commons", [msg])
        assert msg["id"] in verifier._queued or msg["id"] in verifier._verdicts
        # Foreign default-marker body is ignored by this verifier.
        foreign = {
            "id": "foreign",
            "from": "mara",
            "body": DEFAULT_WIRE.prefix_signed("nope", tag),
        }
        verifier.consider("commons", [foreign])
        assert foreign["id"] not in verifier._queued
        assert foreign["id"] not in verifier._verdicts
        assert before is not None  # silence lint for unused

    def test_live_verifier_missing_then_present_reenqueues(self, tmp_path, monkeypatch):
        """Round 8: lookup absence is UNKNOWN — not terminal False in _verdicts."""
        from porch3.verifycli import EXIT_LOOKUP, EXIT_OK
        from porchd.ownership import LiveVerifier

        cfg = make_porch_config(
            tmp_path, owner_room="mara", marker="🦊", label="Mara"
        )
        mid = "20250111-180000-000002-abcdef"
        tag = "20250111T180000Z"
        body = cfg.wire.prefix_signed("⚖️ DR dr-9 accepted", tag)
        msg = {"id": mid, "from": "mara", "body": body}
        present = [False]

        def verify(message_id, *, config, channel=None):
            if not present[0]:
                return EXIT_LOOKUP, f"message id {message_id!r} not found"
            assert config is cfg
            assert channel == "commons"
            return EXIT_OK, "VERIFIED"

        monkeypatch.setattr(
            "porchd.ownership.verify_message_id", verify
        )
        verifier = LiveVerifier(
            channels_root=cfg.channels_dir,
            wire=cfg.wire,
            porch_config=cfg,
        )
        live_first = verifier.verify_now("commons", mid)
        assert live_first is False
        assert mid not in verifier._verdicts
        # Freeze the worker so consider's enqueue is observable (no race).
        monkeypatch.setattr(verifier, "_ensure_worker", lambda: None)
        verifier.consider("commons", [msg])
        assert mid in verifier._queued
        assert mid not in verifier._verdicts
        present[0] = True
        with verifier._lock:
            verifier._queued.discard(mid)
        assert verifier.verify_now("commons", mid) is True
        assert verifier._verdicts.get(mid) is True


class TestLegacyParityFixture:
    """--from-legacy values produce byte-identical default wire prefixes."""

    def test_legacy_values_match_legacy_wire(self, tmp_path):
        vals = legacy_hardcoded_values(home=tmp_path)
        room_dir = Path(vals["owner_room_dir"])
        assert room_dir.parent == tmp_path
        # The legacy migration pins the resident marker; the public default
        # marker is deliberately different and must NOT leak into --from-legacy.
        assert vals["marker"] == "\N{BEARDED PERSON}"  # legacy-migration
        assert vals["marker"] != DEFAULT_MARKER
        cfg = build_config(
            owner_room=vals["owner_room"],
            owner_room_dir=room_dir,
            marker=vals["marker"],
            label=vals["label"],
            env={},
        )
        room_dir.mkdir()
        legacy_wire = compile_wire(vals["marker"])
        assert cfg.wire.prefix_casual("hi") == legacy_wire.prefix_casual("hi")
        assert cfg.wire.prefix_signed("hi", "TS") == legacy_wire.prefix_signed("hi", "TS")
        assert cfg.signing_namespace == f"{vals['owner_room']}-porch"
        assert cfg.principal == f"{vals['owner_room']}@porch"


class TestIdentityCanaries:
    def test_default_wire_tracks_default_marker(self):
        assert DEFAULT_WIRE.marker == DEFAULT_MARKER

    def test_legacy_values_have_required_fields(self):
        vals = legacy_hardcoded_values()
        assert {"owner_room", "owner_room_dir", "marker", "label"} <= vals.keys()


class TestDisabledVerificationIgnoresStaleCache:
    """Item 17: signing_disabled must not render VERIFIED from a stale cache."""

    def test_preload_positive_cache_then_mismatch(self, tmp_path, monkeypatch):
        from porch3 import verify
        from porch3.wire import compile_wire

        cfg = make_porch_config(tmp_path, owner_room="mara", marker="🦊")
        mid = "20250111-120000-000001-abcdef"
        msg = {
            "id": mid,
            "body": "🦊🔏 hello [signed:20250111T120000Z]",
            "from": "mara",
        }
        verify.VERIFY_CACHE.clear()
        verify.set_trust_context(cfg)
        verify.apply_verify_result(mid, " 🔏✓")
        assert verify.verify_badge(msg, wire=cfg.wire) == " 🔏✓"
        assert verify.verified_owner(msg, wire=cfg.wire) is True

        disabled = cfg.with_signing_disabled("label mismatch")
        verify.set_trust_context(disabled)
        assert verify.verify_badge(msg, wire=cfg.wire) == ""
        assert verify.verified_owner(msg, wire=cfg.wire) is False
        # Second config in the same process must not inherit positives.
        other = make_porch_config(tmp_path / "b", owner_room="river", marker="🐉")
        verify.set_trust_context(other)
        assert verify.verified_owner(msg, wire=compile_wire("🦊")) is False
        assert verify.verify_badge(msg, wire=compile_wire("🦊")) != " 🔏✓"
        verify.VERIFY_CACHE.clear()
        verify.set_trust_context(cfg)  # reset


class TestDrstoreTrustContextIsolation:
    """Items 16/19: in-process verify against frozen trust; memos namespaced."""

    def test_memo_does_not_cross_configs(self, tmp_path, monkeypatch):
        from porch3 import drstore
        from porch3.verifycli import EXIT_FAIL, EXIT_OK
        from porch3.wire import compile_wire

        drstore._ACTION_MEMO.clear()
        mid = "20250111-120000-000001-abcdef"
        root = tmp_path / "mail"
        root.mkdir()
        body = "🦊🔏 ⚖️ DR dr-1 accepted [signed:TS]\n"
        store = root / "channels" / "commons" / "messages"
        store.mkdir(parents=True)
        (store / f"{mid}.msg").write_bytes(
            b'{"id":"x"}\n---\n' + body.encode()
        )

        calls = []

        def fake_verify(body_bytes, *, config, wire=None):
            calls.append(config)
            return EXIT_OK, "VERIFIED"

        monkeypatch.setattr(
            "porch3.verifycli.verify_body_bytes", fake_verify
        )
        w = compile_wire("🦊")
        got = drstore.authentic_action(
            mid,
            mail_root=root,
            wire=w,
            config_path=tmp_path / "a.toml",
            principal="mara@porch",
        )
        assert got == ("dr-1", "accepted", None)
        assert calls
        assert calls[0].principal == "mara@porch"
        assert calls[0].source_path == tmp_path / "a.toml"

        # Same mid under a different trust context must not inherit.
        calls.clear()

        def reject(body_bytes, *, config, wire=None):
            calls.append(config)
            return EXIT_FAIL, "FAIL"

        monkeypatch.setattr("porch3.verifycli.verify_body_bytes", reject)
        got_b = drstore.authentic_action(
            mid,
            mail_root=root,
            wire=w,
            config_path=tmp_path / "b.toml",
            principal="other@porch",
        )
        assert got_b is None
        assert calls  # must re-verify, not reuse A's memo
        assert calls[0].principal == "other@porch"
        drstore._ACTION_MEMO.clear()


class TestConfigTrustSeamThreading:
    def test_service_reload_dr_and_live_verifier_use_config_a_not_ambient_b(
        self, tmp_path, monkeypatch
    ):
        """Item 3: constructed config A must reach every in-process verify."""
        from dataclasses import replace
        from pathlib import Path

        from helpers import make_porch_config
        from porch3.config import emit_toml
        from porchd.service import Service
        from porch3 import drstore
        from porch3.verifycli import EXIT_FAIL

        a_dir = tmp_path / "a"
        b_dir = tmp_path / "b"
        cfg_a = make_porch_config(a_dir, owner_room="alice", marker="🦊")
        cfg_b = make_porch_config(b_dir, owner_room="bob", marker="🦊")
        path_a = a_dir / "config.toml"
        path_b = b_dir / "config.toml"
        path_a.write_text(emit_toml(cfg_a))
        path_b.write_text(emit_toml(cfg_b))
        cfg_a = replace(cfg_a, source_path=path_a.resolve())
        cfg_b = replace(cfg_b, source_path=path_b.resolve())

        # Ambient env points at B; constructed service uses A.
        monkeypatch.setenv("PORCH_CONFIG", str(path_b))

        body_calls: list[object] = []
        message_calls: list[object] = []

        def spy_body(body, *, config, wire=None):
            body_calls.append(config)
            return EXIT_FAIL, "FAIL"

        monkeypatch.setattr("porch3.verifycli.verify_body_bytes", spy_body)

        def spy_message(message_id, *, config, channel=None):
            message_calls.append(config)
            return EXIT_FAIL, "FAIL"

        monkeypatch.setattr("porchd.ownership.verify_message_id", spy_message)

        state = tmp_path / "state"
        state.mkdir()
        # Minimal channels so LiveVerifier path exists.
        (cfg_a.channels_dir / "commons" / "messages").mkdir(parents=True)
        mid = "20250111-120000-000001-abcdef"
        (cfg_a.channels_dir / "commons" / "messages" / f"{mid}.msg").write_bytes(
            ('{"id":"%s"}\n---\n🦊🔏 hi [signed:T]\n' % mid).encode()
        )

        monkeypatch.setattr(
            "porch3.roomcheck.assert_acting_room", lambda c: None
        )
        monkeypatch.setattr(
            "porch3.roomcheck.apply_owner_crosscheck", lambda c: c
        )
        monkeypatch.setattr("porchd.service.ledger.prune", lambda *a, **k: None)
        monkeypatch.setattr("porchd.service.imagesvc.prune_uploads", lambda *a, **k: None)

        svc = Service(state, porch_config=cfg_a, config=None)
        # Avoid agent / poller; still run start() for trust pin + reload_dr.
        svc.start(with_agent=False, with_poller=False)
        assert svc.verifier.porch_config is cfg_a
        assert svc.verifier.config_path == path_a.resolve()

        # LiveVerifier must verify under frozen A.
        message_calls.clear()
        svc.verifier.verify_now("commons", mid)
        assert message_calls, "LiveVerifier did not call verify_message_id"
        for cfg in message_calls:
            assert cfg is cfg_a or cfg.owner_room == "alice"
            assert getattr(cfg, "source_path", None) == path_a.resolve()

        # reload_dr / project must also pin A (even with empty log).
        body_calls.clear()
        log = cfg_a.dr_log_path
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(
            '{"type":"ratified","dr":"dr-1","actor_message_id":"%s"}\n' % mid
        )
        svc.reload_dr()
        for cfg in body_calls:
            assert cfg.owner_room == "alice"
            assert getattr(cfg, "source_path", None) == path_a.resolve()
            assert cfg is cfg_a or cfg.principal == cfg_a.principal
