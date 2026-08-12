# porchd / porch mobile — threat model

This document is the honest version of "is the phone thing safe?". It
covers the experimental companion daemon (`porchd`) and the phone web app
it serves. The core porch TUI does not need any of this; if this document
makes you uncomfortable, simply don't run the daemon — you lose nothing
but the phone.

## What the system is

A loopback-only HTTP daemon on the Mac serves the porch as a web app.
The phone reaches it through Tailscale Serve over your tailnet (or an
operator-supplied HTTPS base configured at setup — never a loopback QR).
Pairing binds one device per QR token (2-minute expiry); the device then
holds a bearer secret in a cookie plus a per-device CSRF secret, both
stored server-side as SHA-256 hashes only. Sending signed messages from
the phone requires a **lease** armed on the Mac (`porch-mobile arm`,
8 hours default, 24 maximum): the Mac holds the private key in a
porchd-private ssh-agent; the phone holds intent, the Mac holds authority,
and the key never crosses the network in either direction.

## What is defended, and how

- **Key exfiltration via the phone path.** The private key lives only on
  the Mac (agent socket + key file). No API returns key material; the
  reveal path denylists the key file and its `.pub` explicitly.
- **Unpaired access.** Every **API** route except `POST /api/pair`
  requires the device cookie, and paired state-changing (POST) APIs
  additionally require the per-device CSRF header. The static app shell
  and assets are served **before** device auth — any peer that reaches an
  allowed Host sees the login-less shell (it renders "not paired," but
  its existence is visible). Host is allowlisted on every route; Origin
  is checked on POSTs; both derive from one validated base URL, and
  anything else is 403 before routing.
- **Pairing hijack.** Tokens are single-device, 2-minute, and consumed on
  use; only token hashes touch disk. A QR is only ever minted for a
  validated non-loopback HTTPS base, and the base is setup-only so a QR
  cannot reference an authority the running daemon does not enforce.
- **Unbounded signing.** Signing works only while the lease is live; the
  lease is armed from the Mac, never from the phone, and `porch-mobile
  lock` kills it immediately. While dark, a **signed intent is refused**
  (`signing_unavailable`, draft kept) — never silently downgraded; the
  user may then explicitly choose an unsigned send, visible in the UI
  and verified nowhere.
- **Forged verification.** Verification (badges, DR authority) runs
  against post's trust anchor with held-fd reads, strict one-line wire,
  and tri-state outcomes: only an explicit verifier failure (exit 1 —
  bad crypto, absent or malformed proof, missing detached artifacts) is
  terminal negative; every other nonzero outcome is no verdict, stays
  unknown, and retries. A positive verdict is never derived under one
  config and cached under another.
- **Local-file disclosure via the image path.** A message body naming an
  image path does **not** read it: reveal requires an explicit request
  from the paired device, thumbnails are size-bounded, and the resolved
  real path must fall inside the allow boundary (the user's home by
  default; `PORCHD_REVEAL_ROOTS` narrows it) while a denylist wins over
  the boundary regardless: `~/.ssh`, `~/.gnupg`, `~/Library/Keychains`,
  the owner room directory (the signing key lives there), the mail root,
  porchd's own state root, and the configured key file with its `.pub`.
  Symlink escapes are resolved before the check.

## Adversaries, one at a time

- **A malicious tailnet peer** (can reach the serve URL, never paired).
  Sees the login-less static shell and that the service exists; can
  attempt pairing while a token is alive (2-minute window, one device,
  consumed on use); pairing failures are rate-limited and the server
  holds a hard ceiling of 32 simultaneous requests with body-size and
  time bounds — a bound on abuse, not invisibility. Keep the tailnet
  small; treat live pairing QRs as secrets.
- **A stolen paired device.** Device credentials have **no automatic
  expiry** — they last until you run `porch-mobile revoke`. Unarmed
  ("dark"), the thief still reads every channel and can send
  **unsigned** messages as your porch presence; armed, they can sign as
  you and exercise DR authority for the remainder of the lease. The
  lease bounds signing in time; it does not detect the thief, and it
  does not bound reading at all. Treat the phone like a signed checkbook
  while armed and a readable diary always; revoke fast.
- **A malicious channel sender** (any agent or peer who can write into
  a channel you read). Their text is rendered inert; a planted image
  path is not read unless you explicitly reveal it, and the deny list
  above holds even then — but social-engineering you into revealing a
  path is exactly the play. The reveal prompt names the resolved path;
  read it before tapping.
- **A same-user local process on the Mac.** Not contained. Anything
  running as your user can mutate porchd state, config, and mail, and
  can use the live agent socket to sign while the lease is armed.
  porchd is a network boundary, not a local-privilege boundary.
- **Root / host compromise.** Owns everything above plus the key
  material itself. porchd adds no defense inside that boundary and
  cannot.

## Other honest limits

- **The operator base-URL escape hatch is only as good as the URL.** If
  you point setup at an HTTPS base that terminates somewhere untrusted,
  the pairing page and every subsequent request flow through it. The
  validator enforces syntax (HTTPS, no loopback, no userinfo, no default
  -port mismatch), not trustworthiness.
- **Reachability claims.** `porch-mobile doctor` is offline by design:
  it validates configuration and never proves the phone can actually
  reach anything.
- **Availability.** Nothing hides that the daemon is running from peers
  who can reach it, and a determined tailnet peer can consume the
  request ceiling (denial of service degrades service, never auth).

## Residual honesty

- The whole layer is marked **experimental** because its adversarial
  review is younger than the TUI's, its operational surface (launchd,
  Tailscale, iOS storage behavior) is the least controlled part of the
  stack, and iOS home-screen storage eviction has already produced one
  real client-side amnesia incident. Expect rough edges in exactly that
  seam.
- macOS only, enforced at every entrypoint. The guard has no production
  bypass.
- History is the review record: the commit log carries every adversarial
  finding and fix, and claims in this document are backed by regression
  tests in `tests/`.
