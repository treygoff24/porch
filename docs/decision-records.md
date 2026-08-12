# Decision Records

A Decision Record (DR) is an append-only account of a channel decision. It
connects the discussion that produced a proposal to a signed owner action and
to the current state rendered by porch.

## Flow

1. `/decision <message-prefix> <project> [title]` finds one channel message,
   appends a `proposed` event, and sends a signed offer for the owner.
2. The owner sends `/accept dr-N` or `/reject dr-N`. Porch signs the exact DR
   action body, then records the observed message id as a `ratified` or
   `rejected` event.
3. `porch-dr` replays the JSONL log and projects its current records. Porch
   uses that projection for badges and command checks.

`/supersede <old-dr> <new-dr>` is available only when both records are
ratified. It records a signed replacement action and changes the old record to
`superseded`.

## Authority

The event log is shared, untrusted input. A proposal is useful context, not
authority. Only a verified signed owner message whose complete body authorizes
the exact record and verb can change a record's state. Sender labels, cached
display status, and quoted action text do not count.

Projection validates event structure, ignores malformed lines, and verifies
each action message against the active owner and wire configuration. A record
therefore moves through:

```
proposed -> needs_operator_decision -> ratified | rejected
ratified -> superseded
```

An invalid or unverifiable event remains in history as ignored; it does not
change the projected state.

## Wire format

The store is JSON Lines. Proposal events carry the decision context; action
events refer to the signed channel message that supplies authority.

```json
{"event_id":"20250101T090000Z-a1b2c3","type":"proposed","dr":"dr-3","title":"Use the compact preview","project":"sample-app","channel":"commons","anchor_message_id":"20250101-085900-000001-aa11","detail":"Juniper summarized the consensus.","created":"2025-01-01T09:00:00Z"}
{"event_id":"20250101T091500Z-d4e5f6","type":"ratified","dr":"dr-3","actor_message_id":"20250101-091500-000002-bb22","created":"2025-01-01T09:15:00Z"}
```

The corresponding signed action has no surrounding prose:

```
🦊🔏 ⚖️ DR dr-3 accepted [signed:20250101T091500Z]
```

For a supersession, the action is `⚖️ DR dr-old superseded by dr-new`; the
event uses `dr-new` as `dr` and `dr-old` as `supersedes`.

## Agent use

Agents may propose records through `porch-dr propose` or `/decision`, then
send the resulting offer to the relevant channel. They should use the
projection (`porch-dr list` or `porch-dr show dr-N`) as the state source of
truth, not infer authority from chat text. Agents do not ratify, reject, or
supersede records: those actions require the verified owner message.
