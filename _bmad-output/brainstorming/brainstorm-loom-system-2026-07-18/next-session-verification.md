# Next Session — The Verification System

> Deferred from the 2026-07-18 loom brainstorm as "its own rabbit hole — a lot more technical." This brief seeds that session; the full log is `.memlog.md`.

## Why it was deferred

Verification kept surfacing (it's the loom's differentiator — *proof, not diffs*) but the session's focus was the loom's overall form. The technical depth here — dev servers, replicability, contracts — deserves fresh energy and probably a research pass first.

## Opening inventory (from the log)

- *(user)* Loom = e2e development executor with **integrated surface testing**: Playwright-enabled, evidence provided to the user. Tuned for web dev — but replicability must extend beyond web.
- *(user)* The core technical problem: **how do you stand up a dev server that is reliable for local testing, and how do you make it replicable across project types?**
- *(user)* Dedicate part of the preamble graph to **verification-readiness**: an agent that ensures verification *can* occur. A seed of this exists in the system — expand it into a first-class preamble node.
- *(coach)* The readiness node emits a **verification recipe** artifact (boot command, ports, seeds, probe script) stored as a **map region** — learned once per project, diffed by intake like any region, inherited by every future loom. Fail-closed: *no lab, no experiment.*
- *(parked flip)* "Verification happens after building" — the inversion (contracts first, verification designed during preparation) was deliberately left for this session.
- *(existing invariants to honor)* Verifier stack is capability-walled (no write tools); contracts can only be tightened, never loosened; children escalate to mediation, never to humans; the top-level ALL-verify fails closed.
- *(user)* Evidence feeds the delivery card: claim, proof, synthesized narrative, risk flags — verification output must be *judgeable in seconds*.
- *(user)* Escalation reform applies here too: verification failures should follow **windows-not-doorbells** — push only when dire.

## Starting questions

1. What does a **verification recipe** contain, concretely, for: a Next.js app · a CLI tool · a pure library · an API service? What's the common schema?
2. When the readiness node can't stand up the lab (no dev server, flaky boot), what happens — block the loom, degrade the contract explicitly, or escalate to the user *before* any build spend?
3. How does verification *during* the build (streaming evidence, early kill) relate to the final ALL-verify — same contract sampled early, or a distinct lighter probe set?
4. What makes surface evidence **trustworthy** — how do we prevent a screenshot of the wrong state, a probe that tests the mock, a dev server drifted from prod build?
5. Where does the "how it feels" judgment live in verification — is the feel-critic a verifier lens, a critic-panel seat, or part of the future vision critic?
