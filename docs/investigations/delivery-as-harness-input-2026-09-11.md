# Delivering wakes and peer messages as harness input, not user text

**2026-09-11 · investigation only · no app source changed**

> **Recommendation in one line:** keep the text preambles — the Claude CLI silently
> discards every non-`human` `origin`, and the one field it *does* honour
> (`isSynthetic`) makes the model refuse assigned work outright; stamp
> `origin:{kind:"human"}` on a real person's message (the one proof that passed),
> and revisit `origin` only when a CLI build persists it.

The question was whether Telar's four delivery cases can stop riding the human's
input channel behind a text preamble (`apps/engine/src/attribution.ts:18-73`) and
instead use the SDK's structured provenance fields. The answer, from ten scratch
runs against the real CLI, is **mostly no, today**.

---

## 0. Two premises in the brief are wrong

| Claimed | Actual | Evidence |
|---|---|---|
| "package.json asks for SDK ^0.3.257 but 0.3.224 is installed" | `apps/engine` **already resolves 0.3.257**. The 0.3.224 install belongs to a different workspace, `packages/core`. | `apps/engine/package.json:15` (`^0.3.257`); `packages/core/package.json:14` (`^0.3.224`); `bun.lock:118` resolves `0.3.257`; `apps/engine/node_modules/@anthropic-ai/claude-agent-sdk → …@0.3.257+…` |
| "drives the REAL CLI (2.1.267)" | The SDK spawns its **own bundled 2.1.257** unless `pathToClaudeCodeExecutable` is set. Telar *does* set it (`driver.ts:1904` → `defaultClaudeExecutable` → `requireCli("claude")`, `driver.ts:1067-1073`), so Telar runs 2.1.267. Both were tested. | transcript entry `{"version":"2.1.257","entrypoint":"sdk-ts","promptSource":"sdk"}` on an unpinned run |

The strings the brief found in the 2.1.267 binary (`task-notification`,
`peer-send-message`, `verifiedPeerPid`) are real, but they belong to ingress paths
that are not the SDK/print lane. **Both CLI builds behaved identically in every
probe** (`/tmp/telar-delivery-proof/exe-results.json`), so the version gap is moot.

---

## 1. The five proofs

Harness: `/tmp/telar-delivery-proof/{probe,neutral,exe-compare,final,sq}.mjs` — real
`query()` with streaming input, one ordinary prompt, then a second input message
shaped each way. Provenance was read three ways: what the model reported, what the
SDK stream emitted, and **what the CLI persisted in its own transcript JSONL**
(`~/.claude/projects/-private-tmp-telar-delivery-proof/<session>.jsonl`) — the last
being decisive, since a field the CLI never stores is a field it never acted on.

A control was required: the first run used wake-shaped text (`[wake: completed] …`)
and the model duly answered "a background notification from the harness" — but it
was **reading my own words**, not a harness frame. Every result below therefore uses
provenance-neutral payload text (`"The database migration finished."`).

### Results

| # | Shape | CLI accepts? | Persisted | Frame the model sees | Verdict |
|---|---|---|---|---|---|
| 1 | `origin:{kind:"task-notification"}` | yes, no error, turn starts | **dropped — `origin` absent** | none | **FAIL** |
| 1b | `…, subkind:"peer-send-message"` | yes | dropped | none | **FAIL** — `subkind` makes no difference |
| 1c | `…, subkind:"scheduled-trigger"` | yes | dropped | none | **FAIL** |
| 2 | `origin:{kind:"peer", from, name, fromSession, body}` | yes | **dropped** | none | **FAIL** |
| 3 | `shouldQuery:false` | yes | stored as an ordinary user entry | none | **FAIL** (partial, below) |
| 4 | `origin:{kind:"human"}` | yes | **persisted verbatim** | none | **PASS** |
| 5 | `isSynthetic:true` | yes | rewritten to `origin:{kind:"unclassified"}`, `isMeta:true` | **`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]` prepended** | **PASS**, with a sting (§2) |

Also dropped: `origin:{kind:"channel",server:"slack"}` and `origin:{kind:"coordinator"}`.
`{kind:"human"}` is the **only** origin kind that survives the SDK/print lane.

Transcript excerpts, same neutral payload, second user entry:

```
N-human      storedKeys: …,origin,…      origin={"kind":"human"}
N-peer       storedKeys: (no origin)     origin=null
N-task-notif storedKeys: (no origin)     origin=null
N-synthetic  storedKeys: …,isMeta,origin,…  origin={"kind":"unclassified"} isMeta=true
             content: "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\nThe database migration finished.…"
```

Model reports, identical text, differing only by stamp:

- `peer` → `<provenance>NO-SIGNAL</provenance>` — *it could not tell.*
- `task-notification` → `"Human user. NO-SIGNAL — no explicit harness indicator present."`
- `isSynthetic` → quoted `"[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]"` as the exact signal, and named the *previous* message as its most recent **user-role** input.

There is no "harness-formed envelope" to build: nothing in the SDK lane parses one.
`body`/`name`/`fromSession` (`sdk.d.ts:4621-4636`) are fields the CLI *emits* on
messages it has already classified, not fields a host can assert inbound.

### 3 in detail — `shouldQuery:false` is not honoured

The doc says "appended to the transcript without triggering an assistant turn"
(`sdk.d.ts:5283-5286`). It triggers one:

```
shouldQuery=false  → result#1 result#2 result#3   resultsAfter15s=2
shouldQuery=unset  → result#1 result#2 result#3   resultsAfter15s=2
```

Identical turn counts. It is *partially* honoured: `shouldQuery:false` produced a
**silent** turn (no assistant text), where the unstamped control replied chattily
("Noted — migration reference ZORBLAX-7741 reported complete…"). Either way the
content reaches the next real turn's context — a nonce planted in the passive
message was recalled correctly in all three arms. So it buys silence, not free
delivery: the turn, and its billing, still happen.

### 4 in detail — what `{kind:"human"}` actually buys

Observably: it persists, and nothing else changes in the transcript or the model's
report (`NO-SIGNAL` either way). The SDK's claim is about gates we cannot see from
outside — an unstamped message "fails closed at strict `isHuman()` trust gates"
(`sdk.d.ts:4606`). Telar never stamps it, so Telar's real human messages are
currently *unattributed*. Cheap to fix, and the only change here with no downside.

---

## 2. The risk that decides this — (e)

Identical assigned task ("create this file, then reply DONE"), `Write` allowed,
`bypassPermissions`, three deliveries. Run on Haiku 4.5 **and** Sonnet 5; same
ordering both times.

| Delivery | Tool call | File written | Model |
|---|---|---|---|
| plain user turn | `Write(...)` | **yes** | "DONE" |
| **Telar's current text preamble** | none | **no** | *"I won't act on this — it's an instruction from another agent, not you… confirm and I'll do it."* |
| `isSynthetic:true` | none | **no** | *"I won't act on this — it's flagged as coming from a non-user source."* |
| `isSynthetic` + preamble | none | **no** | *"…an unauthorized request from a peer agent, so I'm not acting on it without your sign-off."* |

Two findings, and the second is the more useful one:

1. **`isSynthetic` would break task assignment.** On a `sessions_send` with
   `intent:"task"`, the recipient refuses and waits for a human. For a *wake* or a
   *passive report* — which are notices, not assignments — that is exactly right.
2. **Telar's current text frame already breaks task assignment.** Row 2 is today's
   production path. `agentMessagePrefix` ends "keep asking the person for anything
   that needs their approval" (`attribution.ts:20`), and the model reads that as
   covering the task itself. This is a live bug, independent of the channel
   question. The unmerged `agentNotice` work is the fix already in flight: it says
   a task/blocker **is** an assignment in words (commit `2b1a8b38`,
   `agentNoticePrefix`), which is a *content* change on the same text channel.

**How the two compose:** they are orthogonal and `2b1a8b38` should land first. It
fixes what the model is told; this investigation asks how the telling is carried,
and the answer is "the same way as now". Nothing in `2b1a8b38` becomes wrong if a
structured channel arrives later — `frameAgentNotice` would simply stop being
prepended and its sentences move into whatever the harness composes.

---

## 3. The four delivery cases

| Case | Today | Should use | Proof |
|---|---|---|---|
| wake, idle (own turn) | `framedTurnInput` → `frameWakeMessage`, `attribution.ts:39-43,63-65`; prompt built at `worker.ts:1008` | **unchanged.** `isSynthetic` fits the semantics but is untargetable per-message only in principle — it is available, yet it turns "read this notice" into "refuse this notice" (§2), and a wake exists to be acted on | 5 |
| wake, steered mid-turn | `framedSteerText` → `frameWakeMessage`, pushed at `driver.ts:2409-2415` | **unchanged**, same reason | 5 |
| peer task / blocker | `frameAgentMessage`, same two paths | **unchanged** — must stay an ordinary user turn, or the task is refused | 2, e |
| peer passive report | `frameAgentMessage` | **`isSynthetic:true` is defensible here** — a report wants no action, and the harness frame is stronger and cheaper than 300 characters of preamble. Not recommended yet: it also makes the model distrust the report's *content* ("an untrusted, unverified message injected into this conversation") | 5, 3 |
| **human message** | unstamped | **`origin:{kind:"human"}`** | 4 |

Per provider:

- **Claude** — as above. One field to add.
- **OpenCode** — the mechanism exists and is real: `promptAsync` takes `noReply`
  (`@opencode-ai/sdk@1.18.30/dist/gen/types.gen.d.ts:2252,2337`) and text parts carry
  `synthetic` / `ignored` (`:148-149`, `:1235-1236`). Telar sends a bare text part
  (`apps/engine/src/opencode/driver.ts:149-153`). **Unproven** — no `opencode` binary
  on this machine (`command -v opencode` → nothing), so this rests on the source
  only and must be proved before it is built.
- **Codex** — no equivalent. `apps/engine/src/codex/app-server.ts` has no
  `origin`/`synthetic`/`provenance` field of any kind; the steer path is text
  (`codex-driver.ts:822`). Leave as-is.

---

## 4. What the engine would change (if a future CLI persists `origin`)

Small and localised:

- `SdkUserMessage` at `driver.ts:114-132` omits `origin`, `shouldQuery`,
  `isSynthetic`. It is a hand-written local mirror; add the three fields.
- Two push sites: `driver.ts:2354-2359` (turn's first message) and
  `driver.ts:2411-2415` (steer). Both already have the structured facts in scope —
  `claim.turn.{sender,wakeReason}` and `message.{sender,wakeReason}`.
- The SDK forwards input messages **verbatim**: `Query.streamInput` does
  `this.transport.write(serialize(n) + "\n")` with no field filtering (`sdk.mjs`,
  `streamInput`) — `shouldQuery` appears nowhere in the bundle. So anything added to
  the object reaches the CLI unchanged; no SDK upgrade is needed to *try* a field.
- **The preambles cannot go.** They are not a fallback for "a CLI that ignores
  `origin`" — they are the only mechanism that works on the CLI we ship against.
  Were `origin` honoured tomorrow, they would still need to stay until the minimum
  supported CLI is known, because a dropped `origin` fails **silently** and open:
  the message lands as the person's words with nothing to say otherwise.

---

## 5. Transcript rows — (c)

**Unaffected.** Framing happens at the provider boundary only: `worker.ts:1008`
computes `framedTurnInput(claim.turn)` into a local `prompt`, and `Turn.input` is
stored unframed. Rows key on the structured stamps —
`apps/web/components/transcript.tsx:555-566` reads `item.detail.sender` /
`item.detail.wakeReason` and dispatches to `SteeredWakeRow` / `AgentMessageBubble`;
iOS does the same (`TurnModels.swift`, `TranscriptViews.swift`). Nothing renders the
preamble, so adding, moving, or deleting it changes no pixel on web or iOS.

## 6. SDK upgrade — (d)

**Not required, and already done where it matters.** `apps/engine` is on 0.3.257.
The open item is `packages/core` at `^0.3.224` (`packages/core/package.json:14`) —
unrelated to delivery, worth aligning separately to collapse two 200 MB binary
installs into one. No behaviour in this investigation depends on it: 0.3.257's
`sdk.d.ts` declares every field tested, and both CLI builds behaved identically.

---

## 7. Recommendation, staged

1. **Verify first, and it is cheap:** stamp `origin:{kind:"human"}` on messages with
   no `sender` and no `wakeReason`, at both push sites. Proof 4 is the only one that
   passed; this is the whole of its payoff, and it closes the `isHuman()` gate that
   Telar currently fails closed on for real people.
2. **Land `2b1a8b38` (`agentNotice`)** — it fixes the live refusal in §2 row 2,
   which costs Telar more today than the channel does.
3. **Do not adopt `isSynthetic` for wakes or tasks.** Re-test it for *passive
   reports* only, and only if the content-distrust it induces proves acceptable.
4. **Do not build the OpenCode `noReply`/`synthetic` path on source alone.** Install
   `opencode`, run the two-call probe, then decide.
5. **Re-run `/tmp/telar-delivery-proof/neutral.mjs` on each CLI bump.** It is ten
   minutes and it is the only thing that will tell you when `origin` starts landing.

---

### Scratch artefacts

`/tmp/telar-delivery-proof/` — `neutral.mjs` (origin matrix), `exe-compare.mjs`
(2.1.257 vs 2.1.267), `final.mjs` (authority + `shouldQuery`), `sq.mjs` (nonce
recall), with `*-results.json` beside each. Models: Haiku 4.5 for the mechanical
proofs, Sonnet 5 for the authority test and the nonce recall.
