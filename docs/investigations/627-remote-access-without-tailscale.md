# Remote access without Tailscale — what it takes, and what it costs

Investigation for #627. No code was written, nothing was deployed, no account was
touched. Every claim about this repo is cited to a file; every claim about a
vendor is cited to that vendor's own documentation and dated.

---

## 1. The answer, in one page

**The security bill is not caused by the relay. It is caused by removing the
tailnet.** Every option in #627 except "keep the tailnet and hide it" makes the
cockpit reachable from the public internet, at which point `lib/remote/gate.ts`
is the only thing between an anonymous request and a machine that can read files,
run commands and spend API credit. Cloudflare, Vercel, WebRTC and Tailscale
Funnel all pay that same bill. So the gate work is not phase two of the relay —
it is the prerequisite for every path, it is the cheapest item on this list, and
some of it is worth doing this week regardless of what gets decided.

**The hosted web cockpit is much closer than it looks, and that is the most
valuable finding here.** The cockpit's UI is already a client-side app with *zero*
server-side engine reads (no `engineClient` call in any `page.tsx` or
`layout.tsx`), and `apps/web/lib/hosts/` is already a complete "drive another
Mac's cockpit through a proxy hop" implementation that carries all 121 API routes
including the SSE stream. The hosted product is not "build a web cockpit". It is
"serve the cockpit we have, and give it a host book that is a database instead of
a file". Weeks, not months — for the happy path. The security design is the long
pole, not the porting.

**Recommended shape, three decisions taken separately:**

| | What | Effort | Operator burden |
|---|---|---|---|
| **A. Now** | Fix the fail-open divergence (§6.1); surface the swallowed `tailscale serve` error; offer **Tailscale Funnel** in the Remote access pane | days | none |
| **B. Next** | Relay data path on **Cloudflare Durable Objects**, reusing the push-relay's exact shape. Move the cockpit off polling first (§7.2) or the poll *is* the cost structure | weeks | real, small |
| **C. Separately** | Hosted web cockpit **on Vercel** — it is the right tool for this half | weeks of porting, months of security design | large, and permanent |

**Do not do:** WebRTC first (§5.3), Cloudflare Tunnel per Mac (§5.4), or a hosted
cockpit that holds users' device tokens in our database (§8.3) — that last one is
the design that turns a breach of us into root on every customer's Mac.

**And the honest sentence about end-to-end encryption:** if we serve the
JavaScript, "we cannot read your work" is a *promise with an audit trail*, not a
property. It can be made a property for the iOS app. It cannot be made one for a
browser cockpit we deploy, and §9 says exactly what residual trust remains and
what the partial mitigations actually buy.

---

## 1a. The sentence that has to survive into the product

Not a finding — a commitment, written where it can be found again rather than
only in the section that derives it (§9). If Telar is ever served from our
origin, this is what the person using it is actually agreeing to, and it belongs
in the product's own words and not only in an investigation:

> **If you use the hosted web cockpit, you are trusting our build pipeline and
> everyone with deploy access to it, on every page load — and the thing behind
> it is a shell on your machine with your API keys.**

Today that sentence is unnecessary, because the cockpit runs from the person's
own Mac and we cannot read their work even in principle. The day we serve the
page is the day it becomes true, and the day it has to be said. Anyone writing
the marketing copy, the onboarding, or the first hosted sign-up screen should
have to delete this paragraph on purpose rather than never meet it.

---

## 2. Where we actually are (verified, not recalled)

### 2.1 The shape today

`apps/web/lib/remote/endpoints.ts` lists four ways in: loopback, LAN, tailnet IP
(CGNAT `100.64/10`), and the MagicDNS HTTPS URL from `TELAR_TAILSCALE_URL`. Only
the last two work away from home and both are Tailscale. **The phone dials the
Mac.** That single fact is what a tailnet is buying, and it is what any
alternative has to replace.

Two gates today, in this order:

1. **The tailnet.** An attacker must already be a node to send a packet at all.
2. **The device token.** `apps/web/proxy.ts` runs `decideApiAccess` on every
   request; `lib/remote/store.ts` holds only sha256 digests of `tlr_`-prefixed
   256-bit tokens, compared in constant time with no early return.

Remove (1) and (2) is alone. Everything (2) is currently relaxed about — no rate
limiting, an unauthenticated reachability probe, a fall-open on a damaged file —
was calibrated against a network an attacker had to join first.

### 2.2 What the gate does and does not do

Read directly rather than described from outside:

- **Exempt from auth entirely:** `/api/ping` and `/api/pair`
  (`EXEMPT_API_PATHS`). Everything else including `/api/health` is gated once
  `requireAuth` is on. Pages are gated too — an unpaired browser is redirected to
  `/pair` so project names never render into HTML.
- **The host is not a guest.** The desktop shell carries a per-launch secret as
  both a header (`x-telar-host`) and a cookie, checked constant-time before any
  device lookup (`lib/remote/host-token.ts`). Per launch, never persisted.
- **Roles.** `full` or `observer`; observers get GET/HEAD only and the
  observer-writable allowlist is deliberately empty.
- **Pairing.** Eight digits (26 bits), five minutes, five wrong guesses burns it
  (`PAIRING_TTL_MS`, `PAIRING_MAX_ATTEMPTS`). One secret: typed, scanned and
  linked are the same code, carried in a URL *fragment* so it never reaches a
  server log.
- **No rate limiting anywhere on `/api`.** There is none in `proxy.ts` and none
  in the route handlers. On a tailnet that is defensible. On a public path it is
  not, and §6.2 says what it costs.
- **No CORS headers anywhere in `apps/web`.** Verified by grep. Every design so
  far assumes same-origin; a hosted browser cockpit calling a Mac directly would
  need CORS added, which is a security decision, not a config line (§8.4).

### 2.3 The relay prior art, and it is not on Vercel

`workers/push-relay/worker.mjs` is a working, deployed, free-plan Cloudflare
Worker with Durable Objects, and its design decisions are the ones this
investigation would otherwise have to invent:

- **A host registry, not public enrollment.** `env.HOSTS` is a JSON array of
  `{id, sha256}`; a 64-hex bearer is hashed and matched before anything else.
  Unknown credential → 401 before any state is touched. "Fail closed. No public
  enrollment endpoint and no app-wide embedded secret."
- **One Durable Object per host** (`HOST_STATE.idFromName(host.id)`), so state
  and limits are per-Mac by construction.
- **Two limits, for two different failures.** 120/minute stops one bad loop
  saturating an isolate; `DAILY_BUDGET = 5000` stops a month of bad loops eating
  the account quota — added after one Mac spent a day pinned at the per-minute
  ceiling and took the whole Cloudflare account past its free-plan limit,
  breaking the desktop updater with it (#584). That incident is the single best
  argument in this repo for per-host daily budgets on anything we operate.
- **Revocation is a redeploy**, and applies at every invocation.
- **The credential never touches argv.** `apps/desktop/push-relay.js` writes it
  to the Keychain by piping to `security ... -w` on *stdin* (twice, for the
  confirmation prompt), from the shell — never from the request-serving process,
  because "a route that could mint the credential every push rides on is a much
  larger thing to get right than a route that can only spend it".

**That lane extends.** A cockpit relay is the same shape with a different
payload: registry → per-host DO → budget → forward. The provisioning path,
the revocation story and the free-plan discipline are already designed and
already tested (`workers/push-relay/worker.test.mjs`).

### 2.4 The seam toward a hosted cockpit — how far it already goes

This is the finding that decides "months or weeks".

**Already there:**

- **The UI is a client app.** Zero `engineClient` imports in any `page.tsx` or
  `layout.tsx`. The front door was explicitly moved off the server (#407): "The
  decision moved to the browser… Nothing here needs a server." So there is no
  server-side rendering of engine state to unpick.
- **A complete remote-Mac proxy.** `lib/hosts/proxy.ts` forwards *any* `/api/**`
  to another cockpit: method, query, body and content headers untouched, the
  caller's own credentials stripped, that Mac's bearer added, the answer carried
  back verbatim so every existing error path still works. It already handles the
  cases that break naive proxies — raw file uploads, PNG bodies, per-route
  timeouts, and `agent/stream` with **no timeout at all** because SSE silence is
  normal.
- **Host-scoped routing with no prop-drilling.** `lib/hosts/client.ts` reads the
  host from the address bar and rewrites `/api/x` → `/api/hosts/:id/x`, so all
  ~28 screens work against a remote Mac without being told. Pages already exist
  under `/hosts/[hostId]/` for the agent, a session, solo and new-session.
- **A book with dedupe/merge/rename rules**, pure and unit-tested
  (`lib/hosts/book.ts`), including "same Mac, new address" collapsing by
  `daemonId`.
- **The browser-tab case is already acknowledged in the UI.**
  `components/settings/updates-section.tsx` renders "This browser tab has no
  updater to check" rather than assuming a desktop bridge.
- **The iOS app is the same model already shipped** (`Stores/Host.swift`): a
  local UUID identity, a `baseURLString`, `daemonId` for dedupe.

**Where it stops — and this is the actual work list:**

1. **Storage is a file on the machine.** `lib/hosts/store.ts` reads
   `$TELAR_HOME/remote/hosts.json`; `lib/remote/store.ts` reads
   `$TELAR_HOME/remote/remote.json`. Both call `remoteHome()`, which *throws
   unless `TELAR_COCKPIT=1`*. A hosted deployment needs a per-user database
   behind the same function signatures. The pure layers (`book.ts`, `gate.ts`)
   port unchanged; only the two `store.ts` files are rewritten.
2. **Device tokens are stored in cleartext, deliberately** — "this directory is
   mode 0700 on a machine the person owns". That reasoning does not survive the
   move to our server. §8.3.
3. **`baseUrl` is user-supplied and only validated as http/https.**
   `normalizeBaseUrl` accepts any hostname. On a laptop that is fine. On our
   server it is SSRF into our own network and metadata endpoints, with our
   credentials attached by the proxy. Needs an allowlist/deny-private-ranges
   rule, or the relay-channel-id design in §8.4 which removes the URL entirely.
4. **Four remote pages, not seventeen.** `/hosts/[hostId]/` covers agent,
   session, solo and new-session. There is no remote settings, usage, or
   project-settings screen. A hosted cockpit needs the remaining screens
   host-scoped, or the route tree inverted so *everything* is host-scoped and
   "local" stops being the default.
5. **Three routes genuinely touch this machine**: `/api/about/icon`,
   `/api/browse` (opens a native dialog — noted in `gate.ts` as a mutation for
   exactly this reason), `/api/hosts`. Every other one of the 121 route files is
   a thin engine proxy. That ratio is why the port is small.
6. **No CORS, by design.** §8.4.
7. **`/api/dictation`, computer-use and the browser-control bridge** assume the
   engine and the machine are the same host; they need auditing one by one
   before a hosted cockpit exposes them.

---

## 3. Vercel, answered honestly for both halves

The brief's first framing ("what would we *need*") and its correction ("he wants
a hosted web product") pull in different directions, so answer both:

**For the data path: no.** As of 2026 Vercel Functions do support WebSockets
natively, so the flat "serverless cannot hold a connection" is out of date — but
the reasons it is the wrong tool survive the update:

- A WebSocket connection *is* a function invocation and inherits the duration
  cap: 300 s default, 800 s on Pro, 1,800 s in beta. A Mac's tunnel would be torn
  down and re-established every few minutes forever.
- **Connections are pinned to an instance, and two connections are not
  guaranteed to land on the same one.** A relay's job is to put the Mac's socket
  and the phone's socket in the same place. That is exactly what this model does
  not promise, and the fix is an external stateful hub — i.e. the thing we would
  have used instead.

**For the web app: yes, and it is what Vercel is for.** A marketing site plus a
Next.js cockpit with client-rendered screens and thin API routes is the archetype
of a good Vercel deployment. The split is natural, not a compromise: **web app on
Vercel, data path on Cloudflare.** Note the operational consequence — two vendors
in the request path, so an incident review has two status pages.

---

## 4. Cloudflare, priced against the free plan we are already on

Figures from Cloudflare's own docs, read 2026-09-18:

| | Free | Paid |
|---|---|---|
| Workers requests | 100,000/day | $5/mo, 10 M/mo included, +$0.30/M |
| Workers CPU | 10 ms/invocation | 30 M CPU-ms/mo included |
| Durable Objects | available on free since Apr 2025 | — |
| DO requests | 100,000/day | per-request above included |
| DO duration | 13,000 GB-s/day | — |
| DO storage | 5 GB account, SQLite only | 10 GB/object |
| DO throughput | ~1,000 req/s soft limit per object | same |

Two details that decide the design:

- **WebSocket hibernation is GA.** An idle connection costs no duration once
  handlers finish, and auto-response messages cost nothing. A Mac parked on an
  open socket all day is nearly free in *duration*.
- **Incoming WebSocket messages are billed as requests at a 20:1 ratio** (100
  messages = 5 requests). Outgoing messages and protocol pings are free.

So the relay's cost is dominated by **inbound messages from the Mac and the
client**, not by connection time. Which makes §7.2 the most important
engineering consequence in this document.

---

## 5. The four architectures, weighed

### 5.1 Outbound tunnel from the Mac to a relay — **recommended data path**

The Mac opens a hibernatable WebSocket to its own Durable Object and keeps it.
The phone or browser dials the same DO over HTTPS/WSS; the DO pipes between them.
No inbound port, no NAT traversal, works on carrier-grade NAT and hotel wifi.

- **HTTPS to the phone:** yes, by construction. Dictation works (§10).
- **Can we read session content:** yes, unless payloads are end-to-end encrypted.
  This is the architecture's real cost and §9 is where it is paid.
- **Cost:** see §7.2 — it is a function of the cockpit's polling shape, and today
  that shape is wrong for a metered path.
- **Reuses:** the push-relay's registry, per-host DO, budget, Keychain
  provisioning and revocation-by-redeploy, all already written and tested.

### 5.2 Keep Tailscale, make it invisible — **recommended first step, and not a straw man**

Two genuinely different versions, and they should not be conflated:

**(a) Tailscale Funnel.** `tailscale funnel` publishes the local port to the
*public internet* over Tailscale's own infrastructure, with a real certificate.
**The client needs nothing installed** — no tailnet, no account, no app. Free on
all plans including Personal (6 users, unlimited devices). Ports 443/8443/10000
only, TLS only, undisclosed non-configurable bandwidth limits, requires MagicDNS
and HTTPS certs on, requires the `funnel` node attribute in the tailnet policy
file, and requires the Tailscale CLI on the Mac.

This is the highest value-per-hour item in the whole issue. It removes the
adoption wall *on the side where it actually hurts* — the phone, the borrowed
laptop, the person you are sharing a session with — for roughly the cost of
another branch in `apps/desktop/tailscale.js`, which already shells `tailscale
serve --bg --https=443` and already classifies its failures.

It does **not** remove Tailscale from the Mac, and it pays the full §6 security
bill: a Funnel URL is as public as a relay URL. Say that plainly in the UI.

**(b) Embed/automate Tailscale.** Ship it, auth it with a generated key, hide the
tailnet. This means becoming the tailnet operator for our users — their devices
in our account, our ACLs, our billing past 6 users at $8/user/month, and a
support burden for other people's networks. The Mac App Store build also
re-prompts TCC consent per `tailscale` spawn, which is why the web process never
spawns it (noted in `endpoints.ts` and `store.ts`). **Not recommended.** Funnel
gets most of the benefit with none of that.

### 5.3 WebRTC data channel, signalling only — **not first**

- Saves per-byte cost when the peer connection succeeds.
- Needs STUN *and* TURN. Mobile carriers commonly present symmetric NAT, so a
  meaningful fraction of the target users — phone, away from home, which is the
  entire use case — fall back to TURN, which is a relay again, with our bill and
  our ability to see the ciphertext envelope.
- Cloudflare Realtime TURN is $0.05/GB with a 1,000 GB/month free allowance,
  which is genuinely cheap, but it is a *second* system to build beside the
  signalling server, not instead of it.
- Buys **no security property** the relay cannot get from encrypting the payload
  (§9), and the browser's DTLS is not something the user can verify any more than
  our TLS is.

Revisit only if bandwidth cost becomes the binding constraint. It will not be
first; polls and messages will be.

### 5.4 Cloudflare Tunnel / ngrok per Mac — **no**

- Cloudflare Tunnel became free with unmetered bandwidth in July 2026, so cost is
  not the objection.
- **Named tunnels require a domain on Cloudflare DNS.** Either each user brings a
  domain (a worse adoption wall than Tailscale) or we hold the domain and issue
  subdomains — at which point we are the operator with all of §11's burden and
  none of the control a purpose-built relay gives us.
- Quick tunnels (`--url`) issue random ephemeral `trycloudflare.com` hostnames
  with no auth and no stability. Not a product surface.
- And it is still a second daemon installed on the Mac. Swapping `tailscaled`
  for `cloudflared` is not the improvement it looks like — the brief was right
  about this one.

---

## 6. The threat model, concretely

### 6.1 The finding that matters most: the shell and the gate disagree about a damaged file

`readRemote()` (`lib/remote/store.ts:201`) resets a file whose `version !== 1` to
`RESET = { requireAuth: false }`. The reasoning is documented and, for a loopback
bind, correct: "the alternative is a cockpit only a reinstall can reopen."

But the desktop shell does not use `readRemote`. `apps/desktop/main.js:553`
`readRemoteFile()` does a raw `JSON.parse` with **no version check**, and:

- `serverBindHost()` (`main.js:563`) binds `0.0.0.0` when the *raw* file says
  `exposure: "network-accessible"` and `requireAuth: true`.
- `publishTailscaleServe()` (`main.js:578`) publishes over `tailscale serve` on
  the same raw check.

So a `remote.json` carrying `version: 2` — written by a newer build, then a
rollback or a downgrade — makes the shell bind every interface and publish to the
tailnet **while the request gate reads `requireAuth: false` and admits
everyone.** The two `setExposure`/`setRequireAuth` invariants that exist
precisely to prevent this (`store.ts:452`, `store.ts:475`) are both bypassed,
because neither is consulted on the read path.

Today the blast radius is the tailnet. Behind a relay or a Funnel it is the
internet. **Fix before anything else ships, regardless of which architecture
wins:** fall open only when the resolved bind is loopback, and give the shell the
same version-aware reader the gate uses.

*(Related, lower severity: a file that fails `JSON.parse` outright makes
`readRemote` throw inside `proxy.ts`, which fails closed with a 500 on every
request. That is the safe direction, but it is an accident of where the
`try` ends, not a decision — worth making explicit.)*

### 6.2 What an unauthenticated request reaches, and what the relay must refuse

With `requireAuth` on, an anonymous caller that can reach the socket gets exactly
two routes:

- **`/api/ping`** — `{ok:true}` and nothing else. Harmless on a tailnet;
  on a public path it is a **confirmation oracle**: "a Telar cockpit is here,
  belonging to this person, currently online". The relay should answer
  reachability *itself* from its own registry and **never forward `/api/ping` to
  the Mac**. Zero product cost; removes the oracle and the free liveness probe.
- **`/api/pair`** — the pairing exchange. Discussed below.

Everything else is 401 (or a redirect to `/pair` for page requests). That is a
genuinely small unauthenticated surface and the gate deserves credit for it.

**What the relay must refuse to forward before authentication:**

1. Anything at all, until the *host* is known — copy `push-relay`'s registry
   check, which runs before any state is touched.
2. `/api/ping` — answered locally, never forwarded (above).
3. `/api/pair` unless a pairing window is *open*, signalled by the Mac. Today the
   Mac silently ignores pairing attempts when nothing is pending; a relay that
   forwards them makes the Mac a free oracle and a free CPU sink.
4. Any request over the per-host budget, with `Retry-After` — the push-relay
   already proves the Mac respects this.
5. Requests with a body over a fixed cap, and connection counts per host.

### 6.3 Pairing over a public path

Today: 8 digits = 26 bits, 5-minute window, 5 attempts, over a network an
attacker had to join. That calibration is sound for a tailnet and **not sound
once the pairing endpoint is public**, for three separate reasons:

1. **The attempt counter is global to the pending pairing, not per-caller.**
   Anyone who can reach `/api/pair` can burn a legitimate user's open code with
   five wrong guesses (`consumePairing` → `"burned"`). On a tailnet that is a
   nuisance; on a public endpoint it is a trivial remote denial of pairing,
   repeatable forever.
2. **5 guesses in 5 minutes is fine; 5 guesses per *window* across thousands of
   windows is not.** An attacker who knows a user is pairing (see the ping
   oracle) gets a 5-in-10⁸ shot per attempt, but across a public relay with many
   users and many windows, the aggregate becomes a real number. Rate-limit per
   source at the relay *and* keep the per-pairing burn.
3. **A code in a QR on a screen is fine. A code typed into a page served by us is
   a code we have seen.** In the hosted design the pairing secret passes through
   our frontend by construction (§9).

**Recommendation for a public pairing path:** keep the 8 digits for typing, but
require *host-side confirmation* — the Mac shows "A device in Berlin wants to
pair. Approve?" and nothing is minted until a human on the Mac says yes. That
converts a guessing game into a phishing problem, which is a much better problem,
and it is the only change here that survives all four architectures. Bind the
pending pairing to the relay channel that requested it, so a code cannot be
redeemed from elsewhere.

### 6.4 What one stolen device token buys

Full role: **everything.** The cockpit proxies to the engine, which reads and
writes files, runs commands, drives a browser, and spends the user's provider
credit. A `tlr_` token is a bearer credential with:

- **No expiry.** `PairedDevice` has `createdAt` and `lastSeenAt`, no `expiresAt`.
- **No binding** to device, IP, or origin. It is valid from anywhere.
- **No rate limit.**
- **Revocation only from the Mac**, and only if the user notices. The signal that
  they would notice by — `lastSeenAt` and `identity.address`, stamped by
  `touchDevice` — exists and is good; it is not surfaced as an alert.

On a tailnet, stealing the token also requires tailnet access. Publicly, a token
in a backup, a synced clipboard, a screenshot, or a compromised browser profile
is complete remote control from anywhere in the world, silently, forever.

**Minimum before a public path:** token expiry with silent renewal on use;
per-token rate limits at the relay; an alert (push — we already have APNs) on
first use from a new address; and make the observer role the default for a device
paired over a public path, with promotion an explicit act on the Mac.

### 6.5 Abuse and rate limiting

We become a tunnel operator. The push-relay incident (#584) is the template for
what goes wrong and the template for the fix: **two limits, one for the isolate
and one for the bill**, counted in a single transaction so a host cannot race
itself past either. Add per-host connection caps, per-message size caps, and a
per-account daily budget that returns `Retry-After` — the desktop already honours
it.

Assume someone will try to tunnel non-Telar traffic. The relay should refuse to
carry anything that is not a Telar protocol frame, which argues for a framed
message protocol rather than a transparent byte pipe.

---

## 7. What the relay actually costs to run

### 7.1 Trust, per architecture

| Architecture | Can we read session content? | What makes the answer "no"? |
|---|---|---|
| Tailscale (today) | **No, even in principle** | Traffic never touches us |
| Tailscale Funnel | **No** | Tailscale relays it; TLS terminates on the Mac's own cert |
| Relay, plaintext | **Yes, all of it** | — |
| Relay, E2E to native app | **No, in practice** | Payload encrypted to a key the Mac and the app hold; Apple signs the binary |
| Relay + hosted web cockpit | **Yes, whenever we choose to** | §9 — nothing, short of promises |

That table is the decision. Everything else is engineering.

### 7.2 The number that should change the design before anything is built

The cockpit polls. From the code: the rail's pass is four reads
(`sessions/live`, `health`, `inbox`, `projects` — `lib/hosts/proxy.ts:63`)
"asked every three to ten seconds"; `AGENT_STATUS_POLL_MS = 3_000`;
`BROWSER_POLL_MS = 3_000`; `AGENT_INBOX_POLL_MS = 15_000`; the mobile worker
ticks at 10 s.

Take a deliberately conservative floor — the rail's four reads every 5 s, plus
agent status every 3 s, and nothing else:

```
(4 / 5 s) + (1 / 3 s)  ≈  1.13 requests/second
                        ≈  97,000 requests/day, per connected cockpit, idle
```

**The Workers/DO free plan is 100,000 requests/day for the whole account.** One
user, sitting idle, is the entire free tier. At paid rates, with the 20:1
WebSocket ratio applied (≈145 k billable requests/month/user), the request line
alone is on the order of **a few cents to ~$1 per active user per month** before
duration, egress or the Vercel side — and it scales with *idle* users, which is
the worst possible cost shape.

**So: move the cockpit from polling to the stream before relaying anything.** The
SSE feed already exists, is already carried by the hosts proxy with no timeout,
and already supports cursor-based reconnect (`after=`). This is the single
highest-leverage piece of work in the whole issue: it makes the relay affordable,
and it makes the app better over any network including the tailnet.

Until that is done, cost projections for any relay are dominated by an
implementation detail we have already decided to change.

---

## 8. Accounts, and the question worth asking

The brief asks whether an account can be made to **not** be a way to reach
someone's Mac. It can — but only if it is designed that way from the first
commit, because the existing host-book code leads directly to the other answer.

### 8.1 The rule

**The account is a directory, not a key.** It says *which* Macs exist and *where*
to reach them. It never holds the credential that authorizes a command.

Consequences, stated so they are chosen rather than discovered:

- Compromising an account reveals *that* you own two Macs and their names. It
  does not grant a single API call against them.
- **Account recovery cannot recover Mac access.** Lose the device credential and
  you re-pair, physically, at the Mac. This will generate support requests and it
  is the correct answer; say so in the UI at pairing time, not at recovery time.
- A rogue employee, a subpoena, or a database breach yields a customer list, not
  a fleet of shells.

### 8.2 What the relay authenticates

Two independent credentials, neither of which is the account password:

- **The Mac → relay**: a per-host credential provisioned into the Keychain from
  the shell. `apps/desktop/push-relay.js` is the pattern, already written.
- **The client → Mac**: the existing `tlr_` device token, minted by *the Mac* at
  pairing. The relay routes it; the relay must not be able to mint it.

The relay authorizes *routing*. The Mac authorizes *action*. Keep those separate
and an account compromise is bounded.

### 8.3 The trap

`lib/hosts/store.ts` stores remote device tokens in cleartext and documents why:
"this directory is mode 0700 on a machine the person owns, and hashing it would
leave nothing to send." Correct on a laptop. **If that module is ported to the
hosted cockpit unchanged, our database holds a full-control credential for every
customer's Mac, and our servers become the highest-value target in the product.**

The porting effort in §2.4 makes that the path of least resistance. It should be
written down as a prohibition now, before someone sensibly reuses the file.

### 8.4 Where the device token lives in a hosted cockpit — the design fork

Three options, and they are not equivalent:

| | Token held by | We can impersonate? | CORS needed? | E2E possible? |
|---|---|---|---|---|
| **(a)** Our server (port `hosts/store.ts`) | us | **yes, always** | no | no |
| **(b)** The browser, sent through our relay | browser | yes (we see the header) | yes | no |
| **(c)** The browser, inside an envelope encrypted to the Mac; relay routes on an opaque channel id | browser | **no** (see §9 caveat) | n/a | yes |

Only **(c)** makes "we cannot reach your Mac" a structural claim. It also removes
the SSRF surface from §2.4(3), because the relay never holds a URL — it holds a
channel id. It is more work, and it is the work that distinguishes this product
from a remote-desktop service.

### 8.5 What still has to be installed — say it in the pitch

"Nothing installed" is true of the *client*. It is not true of the Mac. The
engine, the daemon, the worktrees, the provider credentials and the file access
all live on the user's machine and always will — that is what Telar *is*. The
honest sentence is:

> Install Telar on your Mac once. Then use it from any browser, on any device,
> with nothing else to install.

Anything stronger is a promise the architecture does not make.

---

## 9. End-to-end encryption when we serve the JavaScript

This is the part not to paper over.

### 9.1 For the iOS app: achievable, and worth doing

Pairing establishes a shared secret (or an exchange of public keys) between the
phone and the Mac. The relay carries ciphertext and routes on an opaque channel
id. The relay operator sees: channel id, message sizes, timing. Not content.

This is a real property, because the user's trust anchor is not only us: the
binary is signed, reviewed and distributed by Apple, and it is *pinned* — the
version on the phone today is the version that was reviewed, and it does not
change under them silently.

### 9.2 For a browser cockpit we serve: not achievable as a property

We ship the code that holds the key, on every page load, to every user,
unreviewed, unpinned, and replaceable in one deploy. Any E2E scheme in that
client reduces to "trust that this deploy, and every future deploy, is honest".

Things that sound like fixes and are not:

- **Non-extractable WebCrypto keys in IndexedDB.** Stops a passive read of the
  key. Does nothing against a build that uses the key to decrypt and POSTs the
  plaintext — which is the actual threat.
- **Subresource Integrity.** The hashes are in the HTML *we* serve.
- **"We don't log it."** A policy, not a property. That is fine, but it should be
  called a policy.

Things that genuinely move the needle, with honest prices:

- **Binary transparency**: publish a signed, reproducible hash of every web build
  to an append-only log, and have a *separately distributed* verifier — the
  desktop app or a browser extension — check the page against it before the key
  is used. Real, and it is the only mechanism here that turns a promise into
  something checkable. Cost: weeks to build, reproducible builds as a permanent
  constraint on the frontend, and essentially no user will run the verifier. Its
  value is that it makes an attack *detectable after the fact*, not prevented.
- **Keep content off the web tier**: the hosted cockpit shows the *rail* — which
  sessions exist, which need attention, approve/deny — and session content opens
  in the native app. Preserves a real boundary, at a real product cost.
- **Tiering, stated plainly**: "The hosted cockpit is a convenience. We can
  technically see what passes through it. For work where that matters, use the
  Mac directly or the iOS app." Loses a marketing line; keeps our honesty, which
  is the more expensive asset.

### 9.3 The residual trust, in one sentence

**If you use the hosted web cockpit, you are trusting our build pipeline and
everyone with deploy access to it, on every page load, for as long as you use
it** — the same trust you extend to any SaaS, but larger in consequence, because
the thing behind it is a shell on your machine with your API keys. That sentence
should appear in the product, not just in this document.

---

## 10. HTTPS to the phone, and the feature it decides

`getUserMedia` requires a secure context, so **dictation works only where the
phone gets HTTPS** (`lib/dictation/use-dictation.ts:98`, and the Remote access
pane already says so). Per path:

| Path | HTTPS to the phone? | Dictation |
|---|---|---|
| LAN IP / tailnet IP (`http://100.x:3000`) | no | **broken today** |
| Tailscale Serve (MagicDNS) | yes, real cert | works |
| **Tailscale Funnel** | yes, real cert | works |
| Relay (our origin) | yes, by construction | works |
| Hosted cockpit on Vercel | yes | works |
| Cloudflare Tunnel | yes | works |
| Self-signed cert served by Telar | **only after per-device trust** | see below |

Every candidate architecture delivers HTTPS. The one that does not is the path
most people are on today — the tailnet IP — which is why `tailscaleServe` exists
and why the failure in §11.2 matters.

**On the self-signed thread:** a manually trusted self-signed origin *is* a
secure context, so dictation would work — but on iOS that means downloading a
configuration profile, installing it in Settings, and enabling full trust in
Certificate Trust Settings, per device. That is a worse onboarding than
Tailscale, for one feature. Worth keeping as an escape hatch for LAN-only users
who refuse any cloud dependency; not worth being the recommended path.

---

## 11. The two open threads

### 11.1 Telar serving its own HTTPS

Only worth it for the LAN/offline case (§10). If pursued, the shape is: generate
a per-install CA, serve a leaf for the LAN IP, and give the Remote access pane a
"trust this Mac on your phone" flow with a QR to the profile. Real work, narrow
benefit. **Recommend deferring** in favour of Funnel, which delivers a *real*
certificate for free.

### 11.2 The silent `tailscale serve` failure — fix this week

`apps/desktop/main.js:583`: when serve is requested but Tailscale is missing, not
running, or has HTTPS certs disabled, the shell writes `console.error` and
returns null. **Nothing reaches the user.** They turned on a setting, restarted
as instructed, and got no ts.net URL and no explanation — which is the exact
failure this issue is about, arriving as "remote access doesn't work".

The diagnosis already exists: `apps/desktop/tailscale.js` `classify()` returns
`https-disabled`, `not-logged-in`, `permission-denied`, `not-installed`,
`unknown` — deliberately a label, never raw stderr, because stderr can carry
`tskey-…` auth keys. **Surface the label in the Remote access pane** with the one
action each implies ("Enable HTTPS certificates in the Tailscale admin console").
Cheap, and it is a prerequisite for offering Funnel, which fails in the same ways
plus the `funnel` policy attribute.

---

## 12. Recommendation

**A. This week, independent of the big decision** *(days)*

1. Fix the shell/gate fail-open divergence (§6.1).
2. Surface the `tailscale serve` failure label in the Remote access pane (§11.2).
3. Stop the relay-shaped leaks before they exist: plan to answer `/api/ping` at
   the relay rather than forwarding it (§6.2).

**B. The cheapest real win** *(days–weeks, no infrastructure, no operator role)*

Offer **Tailscale Funnel** beside Tailscale Serve. The client installs nothing,
gets a real certificate, and dictation works. Tailscale stays on the Mac. Ship it
with the §6 gate hardening — host-side pairing confirmation, per-source rate
limits, token expiry, new-address alerts — because a Funnel URL is as public as a
relay URL and those changes are needed for every other option anyway.

**C. Before any relay, change the cockpit's data shape** *(weeks)*

Move the rail from polling to the existing SSE stream (§7.2). Until then, any
relay's cost is set by a detail we have already decided to fix.

**D. The relay** *(weeks)*

Cloudflare Durable Objects, one per Mac, WebSocket hibernation, cloning
`workers/push-relay`'s registry / per-host budget / Keychain provisioning /
revocation-by-redeploy. Not Vercel, for the reasons in §3. Design the wire format
as **encrypted envelopes with an opaque channel id** from the first commit (§8.4c)
— retrofitting E2E onto a plaintext relay is a rewrite, and the native iOS app
gets a genuine confidentiality property out of it (§9.1).

**E. The hosted web product** *(a separate decision, with the security design as
the long pole)*

Vercel is the right host for it. The porting work is smaller than it looks (§2.4)
and is enumerated there. But take the four commitments explicitly, in writing,
before starting:

1. The account is a directory, not a key (§8.1).
2. We never store a device token server-side (§8.3) — and `lib/hosts/store.ts` is
   marked as not-for-porting.
3. We state plainly, in the product, that we can technically see what passes
   through the hosted cockpit, unless and until binary transparency ships (§9.3).
4. The LAN and loopback paths keep working forever, so our login can never lock
   someone out of their own machine (§11 below).

**What it costs, in one place:**

- **Security.** The tailnet stops being the first gate. The device token becomes
  the only one, and it currently has no expiry, no binding, no rate limit and no
  alerting. That is four pieces of work that must land before, not after.
- **Confidentiality.** Today we cannot read a user's work even if we wanted to.
  After a relay, only encryption stops us — and in a browser cockpit we serve,
  not even that, as a property. We would be trading a structural guarantee for a
  promise. That is the real price of the hosted product, and it is worth paying
  only if we say it out loud.
- **Becoming an operator.** Uptime someone is paged for. A quota that breaks
  customers when one Mac loops (#584, already once). Abuse handling. A per-user
  cost that scales with *idle* users. A login that can lock people out of their
  own machines — which is why (4) above is not optional. And a shipping cadence
  where a bad deploy no longer means "users on the old version are fine", because
  there is no old version.

**What I would do:** A + B now, C next regardless, and treat D/E as one product
decision rather than two technical ones — because the moment we serve the
cockpit, §9 is the product, and everything else is plumbing.

---

*Sources for vendor claims, read 2026-09-18:*
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) ·
[DO free tier announcement](https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/) ·
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) ·
[Tailscale pricing](https://tailscale.com/pricing) ·
[Vercel Functions limits](https://vercel.com/docs/functions/limitations) ·
[WebSockets on Vercel](https://ably.com/vercel/websockets-on-vercel) ·
[Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
