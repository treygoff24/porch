# Post-kit core implementation evidence

This is the implementation and verification record for the T3a portion of the approved
2026-09-30 Porch plan. It covers the client, raw/display records, verification, private signing
agent, send transaction, recovery store, attention derivation and polling. The config, drafts,
decision records and polls belong to T3b. Avatar/emote payload validation belongs to pixel.

## Behavior and integration

- `OwnerPost.connect({config, executable?, env?, agent?})` checks the Post owner anchor,
  binds `--harness porch --key <owner_room> --workspace <owner_room>`, then checks the acting
  room. An owner-room mismatch stops access; any other anchor disagreement disables signing
  and yields an unknown verification result. The default config loader imports
  `src/config/index.ts`; the coordinator integrates T3b's exports.
- `OwnerPost.send` and `PostStore.send` use `SendTransaction`. Casual is the default even
  with an armed agent. The recovery copy contains pre-prefix/pre-signature text, exactly as
  Python Porch stores it. The caller owns draft clearing; `shouldClearDraft` applies the
  specified revision/outcome table. Only confirmed receipt IDs gain own-image trust.
- `SendRecord` shares Python's namespace, `.porch-drafts/<namespace>.lock`, exclusive flock,
  record bytes, capacity, permissions, no-follow parent walk and hardlink publication. Its
  `restore` method returns the record and never sends. A missing FFI implementation refuses
  recovery writes, which in turn refuses sends.
- `PostStore` requires `markReadOnView: false`. Polls read since the latest ID, reconcile
  history on open/every fifth poll/focus, and merge by ID. `newRecords` counts eligible late
  imports newer than the acknowledged position. Acknowledgment takes only visible eligible
  records. `trackConfirmed` and the store's send wrapper start the bounded seen-by stream.
- `VerificationScheduler` retries unknowns at 2/4/8/16/32/60 seconds, then every 60 seconds
  while loaded. It emits only when the verdict state changes. Parsing freezes raw records;
  rendering receives `toDisplay(...).text`, never raw text.
- Exact reads start with the specified `--max-bytes 1048576`. Post budgets serialized JSON
  as well as the body, so a full-cap body needs subsequent existing `--offset` reads. These
  are stitched only with matching envelopes, byte totals and contiguous UTF-8 ranges.
- `porch-verify` uses the package-local tsx loader, and preserves 0 verified, 1 failed,
  2 usage/config, 3 lookup and 4 environment. Missing or unsafe evidence gives no verdict.
  This deliberately follows the new unknown policy rather than Python's old missing-file
  failure policy. The library entry is tested with an injected synthetic config; the actual
  executable's usage path is also exercised.
- Package dependencies added: `@estate/pixel: workspace:*` and `tsx: 4.23.15`. The root
  lockfile remains the coordinator's responsibility. pnpm regenerated the importer during
  local commands; that incidental root diff is removed before the lane commit.

## Verification

Every Vitest run used `testrun porch test -- pnpm vitest run --maxWorkers=4 ...`.
Every gate used `testrun porch gate -- scripts/gate.sh`.

The first full gate passed 173 tests with three explicitly named `needs T2 binary` skips.
The final full gate passed 178 tests with those same three skips (17 passed test files,
one skipped file), plus TypeScript and Biome checks. Further checks exercise concurrent
Python flock, queued focus reconciliation, expired seen responses, immutable verification
inputs and the verifier's signature-age warning. `evidence/gate.log` records that run.

One intervening full gate passed all post-kit checks but failed the existing host animation
test's strict floating-point equality: `399.9999999999998` versus `400`, at
`test/host.test.ts:134`. The immediate full rerun passed. This lane did not edit that file;
the failure is retained in `evidence/host-clock-flake.log` and reported to the coordinator.

Real Post tests create and initialize a separate store per test file. They use the absolute
`PORCH_REAL_POST` path, synthetic owner config, temporary HOME and the committed throwaway
Ed25519 key. Python interoperability uses `PORCH_REFERENCE_ROOT` or `~/Code/porch-tui`, with
bytecode writes disabled. No test reads Trey's config, drafts, key or `~/.claude-mail`.

The golden v1 and v2 fixtures verify in the real Post binary (`signed_verified: true`),
Python Porch's verifier (exit 0), and post-kit (verified). The v2 golden body contains ESC,
C1, bidi controls, CRLF and trailing whitespace. Malformed locators, incomplete bodies,
channel mismatches and mutated bodies are covered. Real Post schema and record captures
are retained in `fixtures/`; the throwaway key and signatures are in `vectors/`.

## Red-proofs

Each mutation was applied alone, tested through testrun, and restored from a byte-checked
copy before continuing. Logs are in `evidence/`.

| Boundary broken | Result |
| --- | --- |
| Admit emotes to the attention predicate | 5 failed, 7 passed (`unread-red.log`) |
| Sanitize ESC/C1 before reconstructing the signed manifest | 2 failed, 30 passed (`raw-bytes-red.log`) |
| Remove uncertain-send recovery evidence | 6 failed, 12 passed (`send-retention-red.log`) |
| Treat recovery read errors as an empty list | 3 failed, 10 passed (`corruption-red.log`) |
| Bypass the exclusive flock while Python holds it | 1 failed, 13 passed (`flock-red.log`) |

The Post attention enumerator, bridge publication and Post emote corruption boundaries
belong to T2; this lane does not mutate another lane's source.

## What green does not prove

The three real avatar/emote checks require the merged T2 binary and pixel parser. They are
automatically enabled by the binary's advertised capabilities, and must run with zero skips
before T3 is accepted. The default config loader and actual verifier by-ID launch need T3b
integrated. The coordinator should merge T3a, T3b and T4, resolve the lockfile, install T2,
then run the full gate and the actual verifier against the synthetic config.

The tests prove behavior with a throwaway key and local temporary stores. They do not prove
Trey's live key, Mac FFI/runtime behavior, device rendering, bridge behavior or live agent
wake behavior. The existing Python app and the source checkouts remain untouched.

## Review round 1

Merged main (T1 fixes and T4's actual `parseEmoteRecord`) before applying the assigned
review findings. All assigned findings were verified and accepted; no clarification was
needed. Findings 10 (shared DraftSpace) and 12 (polling efficiency) remain coordinator work.

- Emote receipts may omit `from`; when present it must match the owner. Event, channel and
  nonempty ID are still required. Unknown emote delivery has emote-specific wording.
- A zero-exit `ok: false` response is uncertain and retains recovery and signing evidence.
  Explicit refusals require a nonzero exit; the named delivered errors remain committed.
- The private agent is supervised by a shell reading Node's pipe. EOF from normal exit or
  SIGKILL reaps that agent and removes its socket. `agent.stop()` is public for T6's signal
  handlers. Askpass supplies the phrase once and then an empty line; a wrong phrase reports
  `wrong passphrase` promptly. Tests use an encrypted throwaway key and actually kill Node.
- Own-message exclusion now requires no host and a matching local participant, so bridged
  owner-room messages and other participants in that room can be acknowledged.
- A non-owner's textual mention of signing is unsigned without a locator. Casual owner
  messages are unsigned synchronously on their first display; claims still await verification.
- Crossed-send previews are RawRecords with the receipt's channel context and explicit body
  completeness, and use `toDisplay`. PostError messages and fixes strip display controls.
- Raw parsing contains failures and follows T4's bubble/omitted result. One bad exact read
  preserves its raw record while the rest of the poll completes; scheduled read failures are
  reported and retried, with no unhandled rejection.
- Directory listing uses the held descriptor through `/proc/self/fd` on Linux and `/dev/fd`
  on macOS, removing native dirent offsets and listing's errno dependency. Other native
  operations cache the thread-local errno address rather than calling its accessor afterward.
- The real signer test now checks post-kit's signature in Post and Python Porch as well as
  post-kit. The mark-read test sends from a distinct participant, asserts the unseen before
  state, then verifies only the owner joins the seen set. Another real test pins positive
  unread counts across history, since, exact-message and seen-by reads.

The pre-fix regression run (`review-baseline-red.log`) failed 11 tests and produced one
unhandled rejection, reproducing the receipt, lifetime, passphrase, attention, verification,
display and parser/poll failures. The first restored focused run
(`testrun porch test -- pnpm vitest run --maxWorkers=4 packages/post-kit`) passed 117 tests
with the three named T2 skips. Additional mutation proofs and the final full gate are recorded
below and in the review evidence logs.

| Review red-proof | Result |
| --- | --- |
| Pre-fix emote receipt and zero-exit refusal | 2 failed |
| Pre-fix SIGKILL lifetime and wrong-passphrase retry | 2 failed |
| Pre-fix bridged/local-participant acknowledgment | 1 failed |
| Pre-fix non-owner textual signature claim | 1 failed |
| Pre-fix crossed/error display and emote omission | 3 failed |
| Pre-fix exact-read and scheduled-poll failure containment | 2 failed, one unhandled rejection |
| Restore initial casual attribution to unknown | 1 failed, 34 filtered (`review-casual-attribution-red.log`) |
| Bypass held-descriptor listing with an empty list | 7 failed, 8 passed (`review-descriptor-listing-red.log`) |
| Make history silently mark through its newest message | 1 failed, 7 filtered (`review-cursorless-reads-red.log`) |

The three post-fix mutations were each restored byte-for-byte before continuing. The final
`testrun porch gate -- scripts/gate.sh` passed TypeScript, Biome (99 files), and **358 tests
with three named T2 skips** (28 passed files, one skipped). See `review-gate.log`. Admission
refusals and CPU-pressure waits did not bypass testrun or run duplicate suites.

Green still requires zero-skip T2 acceptance after integration. SIGKILL and directory-listing
evidence is Linux-only; macOS needs its own runtime smoke check. The default config launch
needs T3b, and this round does not address its DraftSpace integration or T6's efficiency work.
