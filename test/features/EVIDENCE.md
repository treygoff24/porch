# T8 features evidence and integration

T8 implements the feature table against the frozen I6 registry at `44df398`.
All changes are confined to this execution workspace. T6 core files are untouched.
Fix-round evidence and current integration notes: [FIX1.md](FIX1.md).

## Changed files

- `src/app/features/`: registry installation, image validation/decoding/spooling,
  poll projection, clipboard/export/seen, decision actions and anchor badges,
  recovery overlay/history hints, archive/unarchive, and emote commands.
- `test/features/`: unit, installed-post, frame, and capture coverage.
- `docs/captures/features-*.png`: features and recovery at 40x52, 100x32,
  and 160x44, through the unchanged T1 capture pipeline.
- Root decoder dependencies only: commit `04a9c4b`,
  `T8 deps: add pure JavaScript PNG and JPEG decoders`.
  `fast-png@8.0.0` and `jpeg-js@0.4.4`; no native decoder build.

## Original T8 verification (c345a5e)

All Vitest runs use `testrun` and `--maxWorkers=4`. The strengthened installed-post
suite passed 6/6 before mutation checks. The restored full gate,
`testrun porch gate -- scripts/gate.sh`, passed lint/format (157 files), TypeScript,
and 525 tests across 46 files, zero skips. This includes all 28 T8 tests. The six
PNG captures were regenerated and visually inspected at the required sizes.
That gate was rerun at `c345a5e` before the original handoff. Fix round 1 follows
Trey's targeted-tests-only ruling; its full gate belongs to the coordinator.

## Red proofs

All five mutations produced exit 1 with an assertion failure, then the exact
original file bytes were restored. Logs are in `test/features/red-proofs/`.

| Boundary removed | Command after `testrun porch test --` | Result |
| --- | --- | --- |
| Vote bypasses context and calls the client transaction | `pnpm vitest run --maxWorkers=4 test/features/e2e.test.ts` | 2 failed, 4 passed; poll receipt assertion failed; dependent decision case also failed |
| Decision action accepts casual mode | same e2e command | 1 failed, 5 passed; casual action called send |
| All image messages trusted automatically | `pnpm vitest run --maxWorkers=4 test/features/images.test.ts` | 1 failed, 10 passed; deferred image was read/rendered |
| Cancelled restore ignores its generation | same e2e command | 1 failed, 5 passed; new draft overwritten by a second setDraft |
| PNG decoder receives bytes without bounded preflight | same images command | 1 failed, 10 passed; duplicate/inflate-bomb fixture decoded instead of refusing |

The installed-post tests use a temporary mail root, owner room, draft/recovery
store, and a committed throwaway test key in a private signing agent. Clipboard
commands and the OSC 52 sink are fakes. The process adapter rejects any feature
write outside `CommandContext.send`.

Coverage includes exact clipboard/export bytes and permissions; latest room
ballots including casual and signed owner votes; voter heads; PNG/JPEG pixels,
packed and indexed PNGs, checksums and allocation budgets; optional ffmpeg present
and absent paths; lexical image consent without deferred filesystem access;
Mac PNGf/TIFF/resampling and channel-preserving paste; verified decision actions,
duplicate actor refusal and observation of an externally sent signed action;
an actual delivered send with an unreadable receipt; recovery retention and
Escape cancellation; archive state; emote delivery with unchanged peer attention
and an ordinary message as a positive attention control. Drawn feature states
have checks at all three sizes. T3's full-gate store tests retain the unsafe-range
integer and floating-point write refusal contract.

## Seams needed from T6

1. Import `./features/index.ts` once during plugin boot. Registration goes through
   I6, including command aliases and message renderers. The command dispatcher
   remains T6's exact-first-token responsibility; unknown slash words must refuse.
2. `runtime.ts` exports `EmoteSendRequest` and `FeatureSend`. Advertise
   `ctx.send.emotes = true` only after the send adapter recognizes the `emote`
   member and routes it to `OwnerPost.emote` behind the core's same in-flight
   admission. Ordinary requests retain the recovery-backed send transaction.
   Emotes have no word draft, recovery record, reply target, or signature.
   Until advertised, `/emote` refuses before sending.
3. Provide `actions.appendImagePath(channel, path)` (see `FeatureActions`) that
   appends to that channel's latest draft, preserving intervening words, revisions,
   and a changed focus. Mac Ctrl+V and pasted paths refuse when it is absent.
   Route a text-paste event through `images.paste(text, snapshot)` first; false
   means ordinary text paste. Hold the normal actions object identity stable:
   caches and recovery sessions use it as the per-app key.
4. Call `decisions.observe(snapshot)` after open-channel polling, with errors
   surfaced. The returned projection from `decisions.refresh` and `badge` can
   feed T6's needs-you state. Observation imports only verified owner action
   messages; projection independently retrieves unique held actor bytes and
   verifies them instead of trusting display metadata.
5. T3's frozen `OwnerPost.channels()` invokes `post channels --json`, which hides
   archived channels in the installed post. Archive/unarchive commands work and
   are read back in e2e. T7's archived browser view needs an upstream listing
   option for `--all`; this lane does not change the frozen client or invent I6.

## Deviations and limits

- Recovery requires opening the record's channel before restoring and refuses
  a nonempty composer. Escape cancels a pending restore, protecting new words.
  Recovery records survive restoration and history matches; only Delete discards.
- Export returns a private transcript path without opening a desktop application.
  This preserves the requested export behavior in a terminal session.
- Image captions show the basename; stored, copied, and exported bytes retain
  the absolute spool path. PNG preflight strips ancillary metadata and caps
  decompression before the pure-JS decoder allocation.
- Porch's tally normalizes casual owner markers. The separate legacy `post-poll`
  program is outside this lane and still has its old raw-body parsing behavior.
- Green tests do not prove live Mac clipboard behavior, phone/SSH OSC 52 support,
  an integrated T6 event loop, live agent wake exclusion, or worst-case 40 MP
  decoder responsiveness. T9 retains those device, integration, and smoke checks.

## Suggested integration

Cherry-pick the `T8 deps:` commit, then the feature commit; resolve the shared
lockfile and install. Wire the seams above and run the full gate at the integrated
head. Preserve this worktree for the orchestrator's inspection and lifecycle.
