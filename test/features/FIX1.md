# T8 fix round 1

Scope: `src/app/features/**`, `test/features/**`, feature captures, and the one
authorized package export in `packages/post-kit/src/index.ts`. No app-core edits,
new dependencies, source-checkout changes, amend, push, or worktree cleanup.

## Items addressed

| Item | Change | Targeted coverage |
| --- | --- | --- |
| 1. Hostile images | PNG/JPEG decode and downsample run only in a worker. Each worker has a 64 MiB old-generation heap, 16 MiB young-generation heap, 4 MiB stack, and a 3 s kill deadline. At most two workers run concurrently. PNG preflight is capped at 32 MiB expanded scanlines; JPEG's allocation budget is 64 MiB. Limits/timeouts produce labelled placeholders. PNG output conversion downsamples before allocating RGBA, including indexed PNGs. | `images.test.ts` (13), `decode.test.ts` (3). Real streamed 64 MiB inflate bomb; real 8000x5000 PNG under 200 KiB; UI heartbeat continues. |
| 2. Recovery hints | First 20 recovery-ID digits supply nanoseconds. Only messages at or after that time minus 5 s skew count. Multiple matches say `ambiguous (N matches)`. Old identical messages do not count. Installed post's local-offset timestamps and UTC ISO timestamps both parse. | `commands.test.ts` (11), `e2e.test.ts` (7). |
| 3. Poll history | Full history loads initially/on explicit open and Ctrl+O, with one in-flight fetch per channel. Arrivals merge by ID, preserving loaded verdicts and arrivals during the fetch. Unchanged frame snapshots reuse the cache. | `polls.test.ts` (1), commands and installed-post poll frames. |
| 4. Emote fallback | Request body is empty. A deliberately misrouted installed-post send adapter cannot create a chat message. | Commands and installed-post emote case. |
| 5. Copy controls | Remove C0/C1 controls except newline/tab, plus Unicode bidi controls. Export retains original bytes. Test includes ESC plus bracketed-paste termination. | Commands case with fake clipboard sink. |
| 6. Decision context | Verified actors must match the proposal's envelope/storage channel and follow its creation time. Both records are checked for supersede. Checks run every projection while retaining T3's verification memo, backoff, and budget. Commands refuse another channel before send. | Installed-post cross-channel, pre-proposal and same-second replay cases, plus valid signed accept/reject/supersede. |
| 7. Failed ballots | Failed verification ballots are excluded from tallies and voter-head selection; their cache verdict survives a full-history merge. | A failed later owner ballot attempts to switch a valid vote in the poll-cache test. |
| 8. URL detection | Image paths require a token boundary; HTTPS and file URLs are not paths. | Image admission test. |
| 9. Captures/clipping | Recovery captures contain both `likely landed as` and `not found` at 40x52, 100x32 and 160x44. Deferred and error labels ellipsize by terminal columns. | Capture case (1), image frame assertions; changed PNGs visually inspected. |
| 10. Package boundary | Add only `export { boundedRead, SafeDirectory } from './safe-fs.ts'` to the package index; both deep feature imports use `@estate/post-kit`. | Image filesystem and installed-post actor lookup cases. |

Image, poll and decision renderers draw body content only. The core owns sender,
verification/claims and reply lines outside the body rectangle. Actions stay
keyed on the existing stable `state.actions`; no workaround for the core lane.

## Verification and red proofs

Only targeted commands ran in this fix round. Final restored check:
`testrun porch test -- pnpm vitest run --maxWorkers=4 test/features`.
Result: **36 passed across 6 files, zero skips**. Scoped Biome checks passed on
21 changed source/test files and the authorized package index.
The coordinator owns the full gate and global TypeScript check.

Thirteen mutations failed with exit 1 and assertion failures, then the original
source bytes were restored. Logs: `red-proofs/fix1/`.

- `png-bomb`: bypass bounded preflight. The **64 MiB bomb assertion itself**
  resolved pixels instead of refusing; the duplicate-header test was not run.
- `worker-kill`: omit termination; both timeout/exhaustion controls fail (2).
- `worker-concurrency`: allow 200 workers; three start instead of two (1).
- `recovery-time`: drop age filter; old identical message becomes a false match (1).
- `poll-refetch`, `poll-overlap`: extra/overlapping history calls detected (1 each).
- `emote-body`: nonempty fallback posts words through a misrouted real adapter (1).
- `copy-controls`: raw bracketed-paste/control bytes reach fake clipboard (1).
- `decision-channel`, `decision-time`, `decision-seconds`: replay wrongly ratifies
  a record when each contextual safeguard is removed (1 each).
- `failed-vote`: failed ballot switches the owner's valid vote (1).
- `url-path`: URLs falsely recognized as local paths (1).

Filtered red-proof runs intentionally exclude unrelated cases. The final restored
feature run exercises all targeted cases. No full suite/gate ran in this round.

## Integration and qualifications

- In addition to the original T6 seams in `EVIDENCE.md`, call
  `polls.open(snapshot, channel)` when opening/reopening a channel. Initial render
  provides a fallback load; the registered Ctrl+O binding refreshes and passes the
  key onward to the core. New arrivals do not trigger a history fetch.
- T3 proposal timestamps have only second precision. To refuse same-second
  replay conservatively, an action must follow the whole recorded second.
  Feature commands wait asynchronously for at most the remainder of that second;
  future/invalid proposal times refuse. Externally sent same-second actions stay
  pending rather than being assumed ordered.
- PNG's second inflation is bounded to 32 MiB, as allowed by the ruling; it is
  confined to the worker. Larger valid PNGs remain attachable with a limited
  preview. `resourceLimits` caps V8 heap, not total OS RSS; separate PNG/JPEG
  allocation budgets and the two-worker cap bound external decoder allocations.
- Decoder/ffmpeg failure labels are previews, not delivery receipts. Existing
  GIF/WebP present/absent tests remain active. Actual Mac clipboard/OSC 52 and
  integrated core-header/needs-you behavior remain the coordinator's smoke checks.
- No signed schema migration or cryptographic binding of a DR title/anchor was
  introduced; the requested channel/time mitigation supplements existing body
  signature authority. Shared logs remain untrusted input.
- The malformed review-extraction command was recorded as a papercut in
  `papercuts.jsonl`, retained in this owned test directory.

Integrate this fix commit after `c345a5e`; keep the existing dependency commit.
Resolve the single export line with the post-kit lane, wire `polls.open`, and run
the coordinator's gate once on the integrated candidate.
