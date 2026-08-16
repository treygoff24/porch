"""Decision Records store: event log, projection, authority boundary."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from helpers import make_porch_config
from porch3 import drstore
from porch3.signature_v2 import manifest_bytes

_DEFAULT_LOCATOR = object()


def _tmp_log(tmp: str) -> Path:
    return Path(tmp) / "decision-records.jsonl"


def _put_channel_msg(
    root: Path, mid: str, body: str, *, channel: str = "commons"
) -> Path:
    """Place a message under the canonical channels/<ch>/messages/ tree."""
    store = root / "channels" / channel / "messages"
    store.mkdir(parents=True, exist_ok=True)
    path = store / f"{mid}.msg"
    path.write_text(body if isinstance(body, str) else body.decode())
    return path


def _install_v2_identity(config, root: Path) -> Path:
    config.sigs_dir.mkdir(parents=True, exist_ok=True)
    key = root / "v2-test-key"
    subprocess.run(
        [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-f",
            str(key),
            "-C",
            config.principal,
            "-N",
            "",
            "-q",
        ],
        check=True,
        capture_output=True,
    )
    algorithm, public_key, *_ = Path(f"{key}.pub").read_text().split()
    config.allowed_signers.write_text(
        f'{config.principal} namespaces="{config.signing_namespace}" '
        f"{algorithm} {public_key}\n"
    )
    os.chmod(config.allowed_signers, 0o600)
    return key


def _write_signed_v2(
    config,
    key: Path,
    *,
    mid: str,
    tag: str,
    body: str,
    storage_channel: str = "commons",
    envelope_channel: str = "commons",
    signed_channel: str = "commons",
    signed_body: str | None = None,
    signature_ref=_DEFAULT_LOCATOR,
) -> Path:
    payload = manifest_bytes(
        tag,
        signed_channel,
        body if signed_body is None else signed_body,
    )
    payload_path = config.sigs_dir / f"{tag}.txt"
    payload_path.write_bytes(payload)
    subprocess.run(
        [
            "ssh-keygen",
            "-Y",
            "sign",
            "-f",
            str(key),
            "-n",
            config.signing_namespace,
            str(payload_path),
        ],
        check=True,
        capture_output=True,
        input=b"\n",
    )
    envelope = {
        "id": mid,
        "from": config.owner_room,
        "channel": envelope_channel,
        "sent": "2025-01-11 18:00:00 -0500",
        "signature_ref": (
            {"version": 2, "tag": tag}
            if signature_ref is _DEFAULT_LOCATOR
            else signature_ref
        ),
    }
    path = config.channels_dir / storage_channel / "messages" / f"{mid}.msg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        json.dumps(envelope, separators=(",", ":")).encode()
        + b"\n---\n"
        + body.encode()
    )
    return path


class DrStoreTest(unittest.TestCase):
    def test_propose_ratify_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            ev = drstore.propose(
                title="adopt worktree isolation",
                project="porch-tui",
                channel="workbench",
                anchor_message_id="m-1",
                path=log,
            )
            self.assertEqual(ev["dr"], "dr-1")
            records = drstore.project(drstore.replay(log), verifier=lambda m: True)
            self.assertEqual(
                records["dr-1"]["state"], "needs_operator_decision"
            )
            drstore.decide("dr-1", "ratified", "mara-msg-9", path=log)
            records = drstore.project(drstore.replay(log), verifier=lambda m: True)
            self.assertEqual(records["dr-1"]["state"], "ratified")
            self.assertEqual(records["dr-1"]["actor_message_id"], "mara-msg-9")

    def test_unverified_ratification_is_ignored(self):
        # The log is untrusted shared state: a forged ratified event whose
        # actor message fails verification must not change the state.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(
                title="t", project="p", channel="c",
                anchor_message_id="m-1", path=log,
            )
            drstore.decide("dr-1", "ratified", "forged-msg", path=log)
            records = drstore.project(
                drstore.replay(log), verifier=lambda m: False
            )
            self.assertEqual(
                records["dr-1"]["state"], "needs_operator_decision"
            )
            ignored = [
                h for h in records["dr-1"]["history"] if "ignored" in h
            ]
            self.assertEqual(len(ignored), 1)

    def test_decided_record_is_immutable_and_supersede_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(
                title="a", project="p", channel="c",
                anchor_message_id="m-1", path=log,
            )
            drstore.propose(
                title="b", project="p", channel="c",
                anchor_message_id="m-2", path=log,
            )
            drstore.decide("dr-1", "ratified", "t-1", path=log)
            # Second decide on a settled record is a no-op.
            drstore.decide("dr-1", "rejected", "t-2", path=log)
            # V1: supersede requires BOTH old and new currently ratified.
            drstore.decide("dr-2", "ratified", "t-3", path=log)
            drstore.supersede("dr-1", "dr-2", "t-4", path=log)
            records = drstore.project(
                drstore.replay(log), verifier=lambda m: True
            )
            self.assertEqual(records["dr-1"]["state"], "superseded")
            self.assertEqual(records["dr-1"]["superseded_by"], "dr-2")
            # dr-2 stays ratified — it is the in-force replacement.
            self.assertEqual(records["dr-2"]["state"], "ratified")
            # Append-only: every event still present in the raw log.
            lines = log.read_text().strip().splitlines()
            self.assertEqual(len(lines), 6)

    def test_corrupt_lines_skipped_and_ids_monotonic(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(
                title="a", project="p", channel="c",
                anchor_message_id="m-1", path=log,
            )
            with open(log, "a") as fh:
                fh.write("{not json\n")
            ev = drstore.propose(
                title="b", project="p", channel="c",
                anchor_message_id="m-2", path=log,
            )
            self.assertEqual(ev["dr"], "dr-2")
            self.assertEqual(len(drstore.replay(log)), 2)

    def test_required_fields_enforced(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            with self.assertRaises(ValueError):
                drstore.append_event(
                    {"type": "proposed", "dr": "dr-1", "title": "x"}, log
                )
            with self.assertRaises(ValueError):
                drstore.append_event({"type": "nonsense", "dr": "dr-1"}, log)

    def test_unsigned_supersede_is_ignored(self):
        # Review blocker: an unsigned superseded line permanently blocked a
        # pending DR. State transitions are all signature-gated now.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(
                title="a", project="p", channel="c",
                anchor_message_id="m-1", path=log,
            )
            drstore.propose(
                title="b", project="p", channel="c",
                anchor_message_id="m-2", path=log,
            )
            drstore.supersede("dr-1", "dr-2", "forged", path=log)
            records = drstore.project(
                drstore.replay(log),
                verifier=lambda ev: ev.get("actor_message_id") != "forged",
            )
            self.assertEqual(
                records["dr-1"]["state"], "needs_operator_decision"
            )

    def test_hostile_lines_cannot_crash_projection(self):
        # Review blocker: one non-string dr value crashed the projection
        # worker and panicked the whole app.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(
                title="a", project="p", channel="c",
                anchor_message_id="m-1", path=log,
            )
            hostile = [
                json.dumps({"type": "proposed", "dr": ["dr-2"], "title": "x",
                            "project": "p", "channel": "c",
                            "anchor_message_id": "m"}),
                json.dumps({"type": "proposed", "dr": 5}),
                json.dumps({"type": "ratified", "dr": "dr-1",
                            "actor_message_id": {"a": 1}}),
                json.dumps({"type": "superseded", "dr": "dr-1",
                            "supersedes": None, "actor_message_id": "x"}),
                json.dumps({"type": "proposed", "dr": "dr-999999999999"}),
                "x" * (drstore._MAX_LINE_BYTES + 10),
            ]
            with open(log, "a") as fh:
                fh.write("\n".join(hostile) + "\n")
            events = drstore.replay(log)
            self.assertEqual(len(events), 1)
            records = drstore.project(events, verifier=lambda m: True)
            self.assertEqual(
                records["dr-1"]["state"], "needs_operator_decision"
            )
            ev = drstore.propose(
                title="b", project="p", channel="c",
                anchor_message_id="m-2", path=log,
            )
            self.assertEqual(ev["dr"], "dr-2")

    def test_action_body_parse_is_full_match_only(self):
        # Review blocker: `search` let an action phrase embedded in any
        # signed message ratify a record. Only the exact wire format parses.
        good = "🦊🔏 ⚖️ DR dr-7 accepted [signed:20250109T050000Z]"
        self.assertEqual(
            drstore.parse_action_body(good), ("dr-7", "accepted", None)
        )
        sup = "🦊🔏 ⚖️ DR dr-4 superseded by dr-9 [signed:x]"
        self.assertEqual(
            drstore.parse_action_body(sup), ("dr-4", "superseded", "dr-9")
        )
        for bad in (
            "🦊🔏 as I said, ⚖️ DR dr-7 accepted [signed:x]",
            "🦊🔏 ⚖️ DR dr-7 accepted and more [signed:x]",
            "🦊🔏 ⚖️ DR dr-2 needs owner — \"⚖️ DR dr-7 accepted\" [signed:x]",
            "⚖️ DR dr-7 accepted",
            "🦊 ⚖️ DR dr-7 accepted [signed:x]",
            "",
        ):
            self.assertIsNone(drstore.parse_action_body(bad), bad)

    def test_v2_action_body_parse_is_exact_and_undecorated(self):
        self.assertEqual(
            drstore.parse_v2_action_body("⚖️ DR dr-7 accepted"),
            ("dr-7", "accepted", None),
        )
        self.assertEqual(
            drstore.parse_v2_action_body("⚖️ DR dr-4 superseded by dr-9"),
            ("dr-4", "superseded", "dr-9"),
        )
        for bad in (
            " ⚖️ DR dr-7 accepted",
            "⚖️ DR dr-7 accepted ",
            "⚖️ DR dr-7 accepted\n",
            "⚖️ DR dr-7 accepted\r",
            "quoted: ⚖️ DR dr-7 accepted",
            "⚖️ DR dr-7 accepted\nextra",
            "🦊🔏 ⚖️ DR dr-7 accepted [signed:x]",
            "",
        ):
            self.assertIsNone(drstore.parse_v2_action_body(bad), bad)

    def test_live_action_parser_selects_from_locator_presence(self):
        v2 = {
            "from": "mara",
            "body": "⚖️ DR dr-7 rejected",
            "signature_ref_present": True,
            "signature_ref": None,
        }
        self.assertEqual(
            drstore.parse_observed_action(v2, owner_room="mara"),
            ("dr-7", "rejected", None),
        )
        self.assertIsNone(
            drstore.parse_observed_action(
                dict(v2, **{"from": "mallory"}), owner_room="mara"
            )
        )
        # A present v2 locator never falls back to decorated v1 parsing.
        copied_v1 = dict(
            v2,
            body="🦊🔏 ⚖️ DR dr-7 accepted [signed:x]",
        )
        self.assertIsNone(
            drstore.parse_observed_action(copied_v1, owner_room="mara")
        )

    def test_concurrent_proposals_get_distinct_ids(self):
        # Review major: id allocation outside the flock collided 10/10.
        import concurrent.futures

        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
                ids = list(
                    ex.map(
                        lambda i: drstore.propose(
                            title=f"t{i}", project="p", channel="c",
                            anchor_message_id=f"m-{i}", path=log,
                        )["dr"],
                        range(5),
                    )
                )
            self.assertEqual(len(set(ids)), 5, ids)

    def test_verify_budget_bounds_verifier_calls(self):
        # Review major: a hostile log must not force unbounded verifier work.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(
                title="a", project="p", channel="c",
                anchor_message_id="m-1", path=log,
            )
            for i in range(50):
                drstore.decide("dr-1", "ratified", f"spoof-{i}", path=log)
            calls = []

            def verifier(mid):
                calls.append(mid)
                return False

            drstore.project(drstore.replay(log), verifier=verifier)
            self.assertLessEqual(len(calls), drstore._MAX_VERIFY_CALLS)

    def test_offer_line_and_badges(self):
        record = {"dr": "dr-3", "title": "t", "project": "p"}
        line = drstore.offer_line(record)
        self.assertIn("/accept dr-3", line)
        self.assertIn("/reject dr-3", line)
        self.assertIn("(project: p)", line)
        self.assertIn("needs Mara", drstore.badge_for("needs_operator_decision", label="Mara"))
        self.assertIn("needs owner", drstore.badge_for("needs_operator_decision"))
        self.assertEqual(drstore.badge_for("unknown"), "")


if __name__ == "__main__":
    unittest.main()


class ActorBindingTest(unittest.TestCase):
    """A genuine Mara action for ONE record must not authorize a forged event
    on ANOTHER (the log is untrusted shared state). Signature alone is not
    authority — the signed body must bind to the exact (dr, verb)."""

    def _stub(self, mapping):
        # authentic_action(mid) → parsed action, simulating porch-verify over
        # a genuinely signed body without minting real ssh signatures.
        from unittest import mock

        return mock.patch.object(
            drstore, "authentic_action",
            side_effect=lambda mid, mail_root=None, wire=None, **kw: mapping.get(mid),
        )

    def test_authorize_binds_dr_and_verb(self):
        accept = {"M": ("dr-1", "accepted", None)}
        with self._stub(accept):
            self.assertTrue(drstore.authorize_action(
                {"type": "ratified", "dr": "dr-1", "actor_message_id": "M"}))
            # Same signed id replayed onto a different record: REJECTED.
            self.assertFalse(drstore.authorize_action(
                {"type": "ratified", "dr": "dr-2", "actor_message_id": "M"}))
            # Verb mismatch (accept id used to reject): REJECTED.
            self.assertFalse(drstore.authorize_action(
                {"type": "rejected", "dr": "dr-1", "actor_message_id": "M"}))
            # No such signed action: REJECTED.
            self.assertFalse(drstore.authorize_action(
                {"type": "ratified", "dr": "dr-1", "actor_message_id": "N"}))

    def test_supersede_binds_both_links(self):
        sup = {"S": ("dr-1", "superseded", "dr-2")}
        with self._stub(sup):
            self.assertTrue(drstore.authorize_action(
                {"type": "superseded", "dr": "dr-2", "supersedes": "dr-1",
                 "actor_message_id": "S"}))
            # Right signature, wrong replacement target: REJECTED.
            self.assertFalse(drstore.authorize_action(
                {"type": "superseded", "dr": "dr-3", "supersedes": "dr-1",
                 "actor_message_id": "S"}))
            # Right signature, wrong superseded target: REJECTED.
            self.assertFalse(drstore.authorize_action(
                {"type": "superseded", "dr": "dr-2", "supersedes": "dr-9",
                 "actor_message_id": "S"}))

    def test_projection_rejects_cross_record_replay(self):
        # End to end: Mara legitimately accepts dr-1; an attacker appends a
        # forged ratified event for dr-2 citing the SAME real accept id.
        # Only dr-1 may ratify.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            drstore.propose(title="b", project="p", channel="c",
                            anchor_message_id="m-2", path=log)
            drstore.decide("dr-1", "ratified", "M", path=log)  # legit
            drstore.decide("dr-2", "ratified", "M", path=log)  # forged replay
            with self._stub({"M": ("dr-1", "accepted", None)}):
                records = drstore.project(drstore.replay(log))
            self.assertEqual(records["dr-1"]["state"], "ratified")
            self.assertEqual(records["dr-2"]["state"], "needs_operator_decision")


class BudgetProgressAndGlobTest(unittest.TestCase):
    """Review finding: the verify budget must not permanently
    starve a real ratification behind junk, and an actor id must not be able
    to walk the mail corpus via a glob metacharacter."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def test_glob_metachar_actor_id_dropped_at_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            # A hostile ratified line whose actor id is a glob → must never
            # survive replay (so it never reaches the corpus walk).
            with open(log, "a") as fh:
                fh.write(json.dumps({"type": "ratified", "dr": "dr-1",
                                     "actor_message_id": "*"}) + "\n")
                fh.write(json.dumps({"type": "ratified", "dr": "dr-1",
                                     "actor_message_id": "../../etc/x"}) + "\n")
            events = drstore.replay(log)
            self.assertTrue(all(
                e.get("actor_message_id") not in ("*", "../../etc/x")
                for e in events
            ))
            # And authentic_action refuses a metachar id without walking.
            self.assertIsNone(drstore.authentic_action("*"))

    def test_budget_delays_but_never_permanently_prevents(self):
        # N junk ids appended AHEAD of a genuine ratification. Per-pass
        # charging would starve the real one forever; memo-miss charging
        # reaches it within ceil(N/cap) passes and it stays ratified.
        from unittest import mock

        n_junk = 2 * drstore._MAX_VERIFY_CALLS + 1  # 17: spans 3 passes
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            for i in range(n_junk):
                drstore.decide("dr-1", "ratified", f"junk-{i}", path=log)
            drstore.decide("dr-1", "ratified", "legit", path=log)

            def fake_authentic(mid, mail_root=None, wire=None, **kw):
                # Simulate real per-id memoization; only "legit" is authentic.
                result = ("dr-1", "accepted", None) if mid == "legit" else None
                drstore._ACTION_MEMO[("", mid)] = result
                return result

            with mock.patch.object(drstore, "authentic_action",
                                   side_effect=fake_authentic):
                events = drstore.replay(log)
                # Pass 1: junk consumes the budget, legit is delayed (NOT yet).
                r1 = drstore.project(events)
                self.assertEqual(r1["dr-1"]["state"], "needs_operator_decision")
                # Successive passes move down the memoized log; bounded.
                ratified = False
                for _ in range(n_junk):  # generous ceiling
                    r = drstore.project(drstore.replay(log))
                    if r["dr-1"]["state"] == "ratified":
                        ratified = True
                        break
                self.assertTrue(ratified, "genuine ratification never reached")


class SupersedeAndAllocationTest(unittest.TestCase):
    """Soul's cross-family review of surfaces 3/4: allocation poison and the
    supersede state machine."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def _ratify_all(self, ev):
        # Test authority: vouch for every actor id (bypasses porch-verify).
        return True

    def test_max_id_poison_does_not_jump_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            # A structurally valid but enormous id in the log.
            with open(log, "a") as fh:
                fh.write(json.dumps({
                    "type": "proposed", "dr": "dr-999999999", "title": "x",
                    "project": "p", "channel": "c", "anchor_message_id": "m",
                }) + "\n")
            ev = drstore.propose(title="a", project="p", channel="c",
                                 anchor_message_id="m-1", path=log)
            # Smallest-unused, NOT 10^9+1 (which replay would drop).
            self.assertEqual(ev["dr"], "dr-1")
            # And the new record actually survives replay/projection.
            records = drstore.project(drstore.replay(log),
                                      verifier=self._ratify_all)
            self.assertIn("dr-1", records)

    def _setup_two_ratified(self, log):
        drstore.propose(title="a", project="p", channel="c",
                        anchor_message_id="m-1", path=log)
        drstore.propose(title="b", project="p", channel="c",
                        anchor_message_id="m-2", path=log)

    def test_supersede_rejects_impossible_transitions(self):
        # pending superseded by pending → rejected (old not ratified).
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            self._setup_two_ratified(log)
            drstore.supersede("dr-1", "dr-2", "s-1", path=log)
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "needs_operator_decision")

        # new not ratified → rejected.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            self._setup_two_ratified(log)
            drstore.decide("dr-1", "ratified", "r-1", path=log)
            drstore.supersede("dr-1", "dr-2", "s-1", path=log)  # dr-2 pending
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "ratified")

        # self-supersede → rejected.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            drstore.decide("dr-1", "ratified", "r-1", path=log)
            drstore.supersede("dr-1", "dr-1", "s-1", path=log)
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "ratified")
            self.assertNotIn("superseded_by", r["dr-1"])

    def test_supersede_cannot_form_cycle(self):
        # A->B valid (both ratified); then B->A must fail because A is now
        # superseded (no longer ratified). No two-node cycle.
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            self._setup_two_ratified(log)
            drstore.decide("dr-1", "ratified", "r-1", path=log)
            drstore.decide("dr-2", "ratified", "r-2", path=log)
            drstore.supersede("dr-1", "dr-2", "s-1", path=log)  # A->B ok
            drstore.supersede("dr-2", "dr-1", "s-2", path=log)  # B->A rejected
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "superseded")
            self.assertEqual(r["dr-1"]["superseded_by"], "dr-2")
            self.assertEqual(r["dr-2"]["state"], "ratified")
            self.assertNotIn("superseded_by", r["dr-2"])


class SupersedeChainAndRejectedTest(unittest.TestCase):
    """Soul's pin list: a positive supersession chain plus the rejected-node
    negatives, complementing SupersedeAndAllocationTest."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def _ratify_all(self, ev):
        return True

    def test_positive_chain_a_b_then_b_c(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            for i in (1, 2, 3):
                drstore.propose(title=f"d{i}", project="p", channel="c",
                                anchor_message_id=f"m-{i}", path=log)
                drstore.decide(f"dr-{i}", "ratified", f"r-{i}", path=log)
            drstore.supersede("dr-1", "dr-2", "s-1", path=log)  # A->B
            drstore.supersede("dr-2", "dr-3", "s-2", path=log)  # B->C
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "superseded")
            self.assertEqual(r["dr-1"]["superseded_by"], "dr-2")
            self.assertEqual(r["dr-2"]["state"], "superseded")
            self.assertEqual(r["dr-2"]["superseded_by"], "dr-3")
            self.assertEqual(r["dr-3"]["state"], "ratified")

    def test_rejected_old_or_new_cannot_supersede(self):
        # rejected old → invalid (never in force).
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            drstore.propose(title="b", project="p", channel="c",
                            anchor_message_id="m-2", path=log)
            drstore.decide("dr-1", "rejected", "x-1", path=log)
            drstore.decide("dr-2", "ratified", "x-2", path=log)
            drstore.supersede("dr-1", "dr-2", "s-1", path=log)
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "rejected")
            self.assertNotIn("superseded_by", r["dr-1"])

        # rejected new → invalid (replacement not in force).
        with tempfile.TemporaryDirectory() as tmp:
            log = _tmp_log(tmp)
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            drstore.propose(title="b", project="p", channel="c",
                            anchor_message_id="m-2", path=log)
            drstore.decide("dr-1", "ratified", "x-1", path=log)
            drstore.decide("dr-2", "rejected", "x-2", path=log)
            drstore.supersede("dr-1", "dr-2", "s-1", path=log)
            r = drstore.project(drstore.replay(log), verifier=self._ratify_all)
            self.assertEqual(r["dr-1"]["state"], "ratified")
            self.assertNotIn("superseded_by", r["dr-1"])


class V2AuthenticActionTest(unittest.TestCase):
    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def test_full_message_verification_precedes_exact_v2_action_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = make_porch_config(root, owner_room="mara", marker="🦊")
            key = _install_v2_identity(config, root)

            valid_mid = "20250111-180000-000001-abcdef"
            _write_signed_v2(
                config,
                key,
                mid=valid_mid,
                tag="20250111T180001Z",
                body="⚖️ DR dr-7 accepted",
            )
            self.assertEqual(
                drstore.authentic_action(
                    valid_mid, mail_root=config.mail_root, config=config
                ),
                ("dr-7", "accepted", None),
            )

            # A genuinely signed body that merely contains an action is not an
            # action instrument: the entire undecorated v2 body must match.
            quoted_mid = "20250111-180000-000002-abcdef"
            _write_signed_v2(
                config,
                key,
                mid=quoted_mid,
                tag="20250111T180002Z",
                body='context says "⚖️ DR dr-7 accepted"',
            )
            self.assertIsNone(
                drstore.authentic_action(
                    quoted_mid, mail_root=config.mail_root, config=config
                )
            )

            # Mutating the stored body after signing fails before action parse.
            mutated_mid = "20250111-180000-000003-abcdef"
            _write_signed_v2(
                config,
                key,
                mid=mutated_mid,
                tag="20250111T180003Z",
                body="⚖️ DR dr-7 rejected",
                signed_body="⚖️ DR dr-7 accepted",
            )
            self.assertIsNone(
                drstore.authentic_action(
                    mutated_mid, mail_root=config.mail_root, config=config
                )
            )

            # The actual storage directory, not the envelope, binds authority.
            moved_mid = "20250111-180000-000004-abcdef"
            _write_signed_v2(
                config,
                key,
                mid=moved_mid,
                tag="20250111T180004Z",
                body="⚖️ DR dr-7 accepted",
                storage_channel="planted",
                envelope_channel="commons",
                signed_channel="commons",
            )
            self.assertIsNone(
                drstore.authentic_action(
                    moved_mid, mail_root=config.mail_root, config=config
                )
            )

            # A present malformed locator selects v2 and never falls back.
            malformed_mid = "20250111-180000-000005-abcdef"
            _write_signed_v2(
                config,
                key,
                mid=malformed_mid,
                tag="20250111T180005Z",
                body="⚖️ DR dr-7 accepted",
                signature_ref=None,
            )
            self.assertIsNone(
                drstore.authentic_action(
                    malformed_mid, mail_root=config.mail_root, config=config
                )
            )


class TimeoutCandidateTest(unittest.TestCase):
    """Soul's HEAD repro: a planted sorts-first candidate that times out must
    not abandon the genuine {mid}.msg (permanent censorship + 10s/pass)."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def test_timeout_candidate_does_not_censor_genuine(self):
        from unittest import mock

        mid = "20250110-210735-833200-1f5b48"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Attacker sibling at mail_root is noncanonical — must never be
            # consulted by the held channels/*/messages lookup.
            (root / f"{mid}!x.msg").write_text("ATTACKER BODY")
            genuine_body = "🦊🔏 ⚖️ DR dr-1 accepted [signed:20250110T210735Z]"
            _put_channel_msg(
                root,
                mid,
                '{"id":"h"}\n---\n' + genuine_body + "\n",
            )

            seen_bodies = []

            def tracking_verify(body, *, config, wire=None):
                seen_bodies.append(body)
                if b"ATTACKER" in body:
                    return (4, "timeout")
                return (0, "VERIFIED")

            with mock.patch(
                "porch3.verifycli.verify_body_bytes", side_effect=tracking_verify
            ):
                got = drstore.authentic_action(mid, mail_root=root)
            # The genuine action is reached...
            self.assertEqual(got, ("dr-1", "accepted", None))
            # ...and the exact-match glob never even opens the
            # planted sibling, so no timeout is ever paid. Guards the star drop.
            self.assertTrue(all(
                (b"ATTACKER" not in (b if isinstance(b, (bytes, bytearray)) else str(b).encode()))
                for b in seen_bodies
            ))


class TimeoutBudgetProgressTest(unittest.TestCase):
    """Soul's second HEAD repro: timeout-only junk ids ahead of a genuine
    ratification must not permanently starve it. The budget-charged set is
    distinct from the verdict memo so a never-memoized timeout id is charged
    once, not every pass."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def test_timeout_junk_prefix_does_not_permanently_starve(self):
        from unittest import mock

        n = drstore._MAX_VERIFY_CALLS  # 8
        with tempfile.TemporaryDirectory() as tmp, \
             tempfile.TemporaryDirectory() as maildir:
            log = _tmp_log(tmp)
            root = Path(maildir)
            genuine_id = "20250110-000000-000000-aaaaaa"
            junk_ids = [f"20250110-0000{i:02d}-000000-bbbbbb" for i in range(n)]
            # Each junk id has one candidate that times out; no genuine file.
            for jid in junk_ids:
                _put_channel_msg(root, jid, "TIMEOUT-MARKER")
            _put_channel_msg(
                root,
                genuine_id,
                '{"h":1}\n---\n🦊🔏 ⚖️ DR dr-1 accepted [signed:x]\n',
            )
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            for jid in junk_ids:  # 8 timeout junk lines AHEAD of the genuine one
                drstore.decide("dr-1", "ratified", jid, path=log)
            drstore.decide("dr-1", "ratified", genuine_id, path=log)

            def fake_verify(body, *, config, wire=None):
                if b"TIMEOUT-MARKER" in body:
                    return (4, "timeout")
                return (0, "VERIFIED")

            with mock.patch.object(drstore, "MAIL_ROOT", root), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes",
                     side_effect=fake_verify,
                 ):
                # Pass 1 is allowed to stay pending (budget spent on junk).
                ratified = False
                for _ in range(n + 2):  # bounded: ceil(n/cap)+slack
                    r = drstore.project(drstore.replay(log))
                    if r["dr-1"]["state"] == "ratified":
                        ratified = True
                        break
            self.assertTrue(ratified, "genuine ratification permanently starved")


class TimeoutBackoffTest(unittest.TestCase):
    """A persistently-timing-out id must stop paying the 10s verify
    timeout every projection (exponential backoff), yet NEVER be skipped
    permanently — a transient failure in front of a genuine signature must
    resolve once the window lapses."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def _timeout_verify(self, calls):
        def verify(body, *, config, wire=None):
            calls.append(body)
            return (4, "timeout")
        return verify

    def test_backoff_window_skips_all_compute(self):
        from unittest import mock

        mid = "20250110-000001-000000-cccccc"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, "TIMEOUT-MARKER")
            calls: list[str] = []
            clock = [1000.0]
            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes",
                     side_effect=self._timeout_verify(calls),
                 ):
                # First attempt pays the timeout once and opens the window.
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertEqual(len(calls), 1)
                # Inside the window: zero verify work, still unresolved.
                clock[0] += drstore._BACKOFF_BASE_S - 1
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertEqual(len(calls), 1)
                # Window lapsed: retried (strike 2), window doubles.
                clock[0] += 2
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertEqual(len(calls), 2)
                strikes, retry_at = drstore._backoff_for(mid)
                self.assertEqual(strikes, 2)
                self.assertAlmostEqual(
                    retry_at - clock[0], 2 * drstore._BACKOFF_BASE_S)

    def test_backoff_is_capped_never_permanent(self):
        from unittest import mock

        mid = "20250110-000002-000000-dddddd"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, "TIMEOUT-MARKER")
            calls: list[str] = []
            clock = [0.0]
            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes",
                     side_effect=self._timeout_verify(calls),
                 ):
                max_delay = 0.0
                # 1100 strikes crosses the 2.0**1024 OverflowError boundary
                # (Soul): the exponent clamp must hold, not just min-with-cap.
                for _ in range(1100):
                    drstore.authentic_action(mid, mail_root=root)
                    _, retry_at = drstore._backoff_for(mid)
                    max_delay = max(max_delay, retry_at - clock[0])
                    clock[0] += drstore._BACKOFF_CAP_S + 1
            # Every lapsed window retried (never a permanent skip)...
            self.assertEqual(len(calls), 1100)
            # ...and no window ever exceeded the cap.
            self.assertEqual(max_delay, drstore._BACKOFF_CAP_S)

    def test_transient_timeout_then_success_resolves_and_clears(self):
        from unittest import mock

        mid = "20250110-000003-000000-eeeeee"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(
                root,
                mid,
                '{"h":1}\n---\n🦊🔏 ⚖️ DR dr-1 accepted [signed:x]\n',
            )
            flaky = [True]

            def verify(body, *, config, wire=None):
                if flaky[0]:
                    return (4, "timeout")
                return (0, "VERIFIED")

            clock = [0.0]
            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes", side_effect=verify
                 ):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                flaky[0] = False
                # Still inside the window: not yet retried.
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                # Window lapses: genuine signature resolves — delayed, not denied.
                clock[0] += drstore._BACKOFF_BASE_S + 1
                self.assertEqual(
                    drstore.authentic_action(mid, mail_root=root),
                    ("dr-1", "accepted", None))
            # Clean resolution wipes the strike record and memoizes.
            self.assertFalse(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))
            self.assertTrue(any(m == mid for _, m in drstore._ACTION_MEMO))


class RealisticTimeoutClockTest(unittest.TestCase):
    """Soul's HEAD re-execution of 8304919: an instantaneous fake TimeoutExpired
    hides that each timeout consumes 10 REAL seconds, so windows opened early
    in a pass can lapse before the pass ends and the next projection re-pays
    the whole junk prefix. This regression advances the clock 10s inside every
    timeout: pass 1 pays the prefix once, pass 2 must pay ZERO timeouts and
    still ratify the genuine signature behind it."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def test_second_projection_pays_zero_timeouts(self):
        from unittest import mock

        n = drstore._MAX_VERIFY_CALLS  # 8
        # Guard the structural invariant the fix relies on: the base must
        # outlive the worst-case wall time of one capped pass.
        self.assertGreater(drstore._BACKOFF_BASE_S, n * 10)
        with tempfile.TemporaryDirectory() as tmp, \
             tempfile.TemporaryDirectory() as maildir:
            log = _tmp_log(tmp)
            root = Path(maildir)
            genuine_id = "20250110-000000-000000-aaaaaa"
            junk_ids = [f"20250110-0000{i:02d}-000000-bbbbbb" for i in range(n)]
            for jid in junk_ids:
                _put_channel_msg(root, jid, "TIMEOUT-MARKER")
            _put_channel_msg(
                root,
                genuine_id,
                '{"h":1}\n---\n🦊🔏 ⚖️ DR dr-1 accepted [signed:x]\n',
            )
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            for jid in junk_ids:
                drstore.decide("dr-1", "ratified", jid, path=log)
            drstore.decide("dr-1", "ratified", genuine_id, path=log)

            clock = [0.0]
            timeout_calls_by_pass: list[int] = []

            def fake_verify(body, *, config, wire=None):
                if b"TIMEOUT-MARKER" in body:
                    clock[0] += 10.0  # a timeout consumes its full 10s
                    timeout_calls_by_pass[-1] += 1
                    return (4, "timeout")
                clock[0] += 0.1
                return (0, "VERIFIED")

            with mock.patch.object(drstore, "MAIL_ROOT", root), \
                 mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes",
                     side_effect=fake_verify,
                 ):
                timeout_calls_by_pass.append(0)
                r1 = drstore.project(drstore.replay(log))
                timeout_calls_by_pass.append(0)
                r2 = drstore.project(drstore.replay(log))
            # Pass 1 pays the junk prefix once (budget-capped at n).
            self.assertEqual(timeout_calls_by_pass[0], n)
            # Pass 2, immediately after: every junk window still open — zero
            # repeat compute — and the genuine ratification lands.
            self.assertEqual(timeout_calls_by_pass[1], 0)
            self.assertEqual(r2["dr-1"]["state"], "ratified")

class DuplicateCandidateFailClosedTest(unittest.TestCase):
    """Soul r4: duplicate exact-basename {mid}.msg copies are an attack
    signature (real corpus has globally unique ids). Authenticating THROUGH
    duplicate trees cost unbounded verify work however the walk was
    batched — so duplicates fail closed at ZERO verifier cost, unmemoized:
    remove the planted copy and the genuine file resolves next projection."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    GENUINE = '{"h":1}\n---\n🦊🔏 ⚖️ DR dr-1 accepted [signed:x]\n'

    def test_duplicates_fail_closed_with_zero_verifier_calls(self):
        from unittest import mock

        mid = "20250110-000004-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, self.GENUINE, channel="commons")
            planted = _put_channel_msg(
                root, mid, "TIMEOUT-MARKER", channel="planted"
            )
            calls = []
            clock = [0.0]

            def verify(body, *, config, wire=None):
                calls.append(body)
                return (0, "VERIFIED")

            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes", side_effect=verify
                 ):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertEqual(len(calls), 0)  # fail closed spends nothing
                # NOT memoized, but backed off (Soul r5): removing the planted
                # copy unblocks after the bounded retry window, never sooner.
                self.assertFalse(any(m == mid for _, m in drstore._ACTION_MEMO))
                planted.unlink()
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                clock[0] += drstore._BACKOFF_BASE_S + 1
                got = drstore.authentic_action(mid, mail_root=root)
            self.assertEqual(got, ("dr-1", "accepted", None))
            self.assertFalse(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))  # strikes cleared

    def test_projection_repeated_mid_duplicate_flood_spends_no_verifies(self):
        """Soul's end-to-end repro: 25 exact-name fast-reject duplicates plus
        four decision events carrying the SAME mid. One project() must not
        exceed the advertised cap (a mutation back to per-event cursor
        batches spawned 25). Fail-closed spends zero."""
        from unittest import mock

        mid = "20250110-000005-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp, \
             tempfile.TemporaryDirectory() as maildir:
            log = _tmp_log(tmp)
            root = Path(maildir)
            for i in range(25):
                _put_channel_msg(
                    root, mid, "REJECT-MARKER", channel=f"d{i:02d}"
                )
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            for _ in range(4):  # repeated events, same unresolved mid
                drstore.decide("dr-1", "ratified", mid, path=log)
            calls = []

            def verify(body, *, config, wire=None):
                calls.append(body)
                return (1, "FAIL")

            with mock.patch.object(drstore, "MAIL_ROOT", root), \
                 mock.patch(
                     "porch3.verifycli.verify_body_bytes", side_effect=verify
                 ):
                r = drstore.project(drstore.replay(log))
            self.assertLessEqual(len(calls), drstore._MAX_VERIFY_CALLS)
            self.assertEqual(len(calls), 0)  # fail-closed exact bound
            self.assertEqual(r["dr-1"]["state"], "needs_operator_decision")

    def test_single_candidate_paths_unchanged(self):
        # Uniqueness enforced: zero candidates is UNKNOWN (backoff, not memo);
        # one genuine candidate memoizes its action.
        from unittest import mock

        mid_none = "20250110-000006-000000-ffffff"
        mid_good = "20250110-000007-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid_good, self.GENUINE)

            def verify(body, *, config, wire=None):
                return (0, "VERIFIED")

            with mock.patch(
                "porch3.verifycli.verify_body_bytes", side_effect=verify
            ):
                self.assertIsNone(
                    drstore.authentic_action(mid_none, mail_root=root))
                self.assertEqual(
                    drstore.authentic_action(mid_good, mail_root=root),
                    ("dr-1", "accepted", None))
            self.assertFalse(any(m == mid_none for _, m in drstore._ACTION_MEMO))
            self.assertTrue(any(m == mid_none for _, m in drstore._TIMEOUT_BACKOFF))
            self.assertEqual(
                drstore._memo_for(mid_good), ("dr-1", "accepted", None))


class MissingThenPresentLookupTest(unittest.TestCase):
    """Round 8: MessageNotFound is EXIT_LOOKUP/UNKNOWN, never a memoized
    terminal None. After the bounded backoff, a later appearance ratifies."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    GENUINE = '{"h":1}\n---\n🦊🔏 ⚖️ DR dr-1 accepted [signed:x]\n'

    def test_missing_then_present_ratifies(self):
        from unittest import mock

        import porch3.verifycli as vc

        mid = "20250111-180000-000001-abcdef"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real_held = vc.held_read_unique_message_record
            held_calls = []
            present = [False]

            def held(mail_root, message_id, **kw):
                held_calls.append(message_id)
                if not present[0]:
                    raise vc.MessageNotFound(f"message id {message_id!r} not found")
                return real_held(mail_root, message_id, **kw)

            clock = [0.0]
            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch.object(vc, "held_read_unique_message_record", held), \
                 mock.patch.object(
                     vc, "verify_body_bytes",
                     return_value=(vc.EXIT_OK, "VERIFIED"),
                 ):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertEqual(len(held_calls), 1)
                self.assertFalse(any(m == mid for _, m in drstore._ACTION_MEMO))
                self.assertTrue(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))
                # Plant the genuine signed action; move past backoff.
                _put_channel_msg(root, mid, self.GENUINE)
                present[0] = True
                clock[0] += drstore._BACKOFF_BASE_S + 1
                got = drstore.authentic_action(mid, mail_root=root)
            self.assertEqual(got, ("dr-1", "accepted", None))
            self.assertEqual(len(held_calls), 2)
            self.assertEqual(
                drstore._memo_for(mid), ("dr-1", "accepted", None))
            self.assertFalse(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))


class AmbiguityGlobFloodTest(unittest.TestCase):
    """Soul r5: duplicate ambiguity was unmemoized AND un-backoffed, so every
    repeated event for the same mid re-globbed the full mail corpus — 100
    repeated events made 100 recursive scans in one projection (0 subprocesses,
    but hostile-log length x corpus size of pure glob work). The duplicate
    path must open a backoff window so repeated events skip BEFORE the glob."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def test_100_repeated_ambiguous_events_glob_exactly_once(self):
        from unittest import mock

        import porch3.verifycli as vc

        mid = "20250110-000008-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp, \
             tempfile.TemporaryDirectory() as maildir:
            log = _tmp_log(tmp)
            root = Path(maildir)
            _put_channel_msg(root, mid, "COPY-A", channel="commons")
            _put_channel_msg(root, mid, "COPY-B", channel="planted")
            drstore.propose(title="a", project="p", channel="c",
                            anchor_message_id="m-1", path=log)
            for _ in range(100):
                drstore.decide("dr-1", "ratified", mid, path=log)

            lookup_calls = []
            real_held = vc.held_read_unique_message_record

            def counting_held(mail_root, message_id, **kw):
                lookup_calls.append(message_id)
                return real_held(mail_root, message_id, **kw)

            clock = [0.0]

            with mock.patch.object(drstore, "MAIL_ROOT", root), \
                 mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch.object(
                     vc, "held_read_unique_message_record", counting_held
                 ), \
                 mock.patch.object(
                     vc, "verify_body_bytes",
                     return_value=(vc.EXIT_OK, "VERIFIED"),
                 ):
                r = drstore.project(drstore.replay(log))
            # One held lookup for the first event; 99 repeats skip inside window.
            self.assertEqual(len(lookup_calls), 1)
            self.assertEqual(r["dr-1"]["state"], "needs_operator_decision")


class TransientIOErrorTest(unittest.TestCase):
    """Soul (cs-cmq): a transient corpus I/O error must never be promoted to
    a permanent negative verdict. Read/glob OSError opens the bounded backoff
    unmemoized; after recovery the genuine signature resolves. Clean
    invalid-signature verdicts still memoize None."""

    def setUp(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    def tearDown(self):
        drstore._ACTION_MEMO.clear()
        drstore._BUDGET_CHARGED.clear()
        drstore._TIMEOUT_BACKOFF.clear()

    GENUINE = '{"h":1}\n---\n🦊🔏 ⚖️ DR dr-1 accepted [signed:x]\n'

    def _verified_body(self):
        import porch3.verifycli as vc

        return (vc.EXIT_OK, "VERIFIED")

    def test_transient_read_error_then_success(self):
        from unittest import mock

        import porch3.verifycli as vc

        mid = "20250110-000009-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, self.GENUINE)
            real_held = vc.held_read_unique_message_record
            flaky = [True]

            def flaky_held(mail_root, message_id, **kw):
                if flaky[0]:
                    raise OSError("transient")
                return real_held(mail_root, message_id, **kw)

            clock = [0.0]
            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch.object(
                     vc, "held_read_unique_message_record", flaky_held
                 ), \
                 mock.patch.object(
                     vc, "verify_body_bytes",
                     return_value=self._verified_body(),
                 ):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                # NOT memoized — backed off.
                self.assertFalse(any(m == mid for _, m in drstore._ACTION_MEMO))
                self.assertTrue(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))
                flaky[0] = False
                clock[0] += drstore._BACKOFF_BASE_S + 1
                self.assertEqual(
                    drstore.authentic_action(mid, mail_root=root),
                    ("dr-1", "accepted", None))
            self.assertFalse(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))

    def test_transient_glob_error_then_success(self):
        from unittest import mock

        import porch3.verifycli as vc
        from porch3.verifycli import LookupIOError

        mid = "20250110-000010-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, self.GENUINE)
            real_held = vc.held_read_unique_message_record
            flaky = [True]

            def flaky_held(mail_root, message_id, **kw):
                if flaky[0]:
                    raise LookupIOError("transient")
                return real_held(mail_root, message_id, **kw)

            clock = [0.0]
            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch.object(
                     vc, "held_read_unique_message_record", flaky_held
                 ), \
                 mock.patch.object(
                     vc, "verify_body_bytes",
                     return_value=self._verified_body(),
                 ):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertFalse(any(m == mid for _, m in drstore._ACTION_MEMO))
                self.assertTrue(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))
                flaky[0] = False
                clock[0] += drstore._BACKOFF_BASE_S + 1
                self.assertEqual(
                    drstore.authentic_action(mid, mail_root=root),
                    ("dr-1", "accepted", None))

    def test_clean_invalid_signature_still_memoizes_none(self):
        from unittest import mock

        import porch3.verifycli as vc

        mid = "20250110-000011-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, "not an action body")

            with mock.patch.object(
                vc, "verify_body_bytes",
                return_value=(vc.EXIT_FAIL, "nope"),
            ):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
            self.assertTrue(any(m == mid for _, m in drstore._ACTION_MEMO))  # clean negative memoizes
            self.assertIsNone(drstore._memo_for(mid))
            self.assertFalse(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))

    def test_rc4_verify_is_not_permanently_memoized(self):
        """Item 3: EXIT_ENV must back off, never memo-serve None forever."""
        from unittest import mock

        import porch3.verifycli as vc

        mid = "20250110-000012-000000-ffffff"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _put_channel_msg(root, mid, self.GENUINE)
            clock = [0.0]
            outcomes = [(vc.EXIT_ENV, "io"), self._verified_body()]

            def flaky_verify(body, *, config, wire=None):
                return outcomes.pop(0)

            with mock.patch.object(drstore, "_now", lambda: clock[0]), \
                 mock.patch.object(vc, "verify_body_bytes", side_effect=flaky_verify):
                self.assertIsNone(drstore.authentic_action(mid, mail_root=root))
                self.assertFalse(any(m == mid for _, m in drstore._ACTION_MEMO))
                self.assertTrue(any(m == mid for _, m in drstore._TIMEOUT_BACKOFF))
                clock[0] += drstore._BACKOFF_BASE_S + 1
                self.assertEqual(
                    drstore.authentic_action(mid, mail_root=root),
                    ("dr-1", "accepted", None),
                )
