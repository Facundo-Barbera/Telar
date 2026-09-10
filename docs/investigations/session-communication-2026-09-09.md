# Session communication and transcript flooding

The Run Configurations checkpoint shown in the screenshot was explicitly sent
to the pinned coordinator through `sessions_send`; its stored sender and target
match the tool call. This incident does not show cross-session misrouting.

The coordinator had 15 persistent subscriptions accumulated across old work.
Direct reports, terminal notifications, and acknowledgements all became further
model input. The later disk-full incident produced several direct reports and
completion notices containing only “Holding”. Direct messages were expanded raw
text outside the normal conversation width when delivered as steering; entire
machine-triggered replies also occupied the main history.

## Changes

- Direct messages are collapsed activity rows at the normal 50rem maximum width,
  in both idle and steering paths. Expanded content uses the shared Markdown
  renderer and a 24rem scrolling body.
- Machine-triggered turns, including their replies, start behind a disclosure.
  Human messages, human steering, and pending requests remain visible. Stored
  messages and history are not deleted or rewritten.
- The agent subscription tool defaults to one matching notification. Ongoing
  monitoring requires explicit `once: false`; the lower-level subscription API
  retains compatibility. Tool instructions discourage duplicate reports and
  acknowledgements and describe steering accurately.
- A human session Stop persists `agentMessagesBlocked`. Subsequent peer messages
  are refused, and subscription wakes are skipped, until a fresh human message
  is accepted. Nothing accumulates for replay. Replaying an old Stop receipt
  does not reapply this guard to newer work.

## Incident containment

The pinned coordinator's 15 subscriptions were saved and removed through the
engine API. A session Stop was requested; it had no remaining active turns at
that instant. The backup is in Telar's application-support `diagnostics` folder,
`pinned-subscriptions-before-containment-20260909.json`. Do not blindly restore
all of these old subscriptions or resume a notification backlog.

## Awaited results and blockers

The follow-up delivery policy makes `sessions_send` passive by default. Routine
reports are durable, collapsed activity; they never enter the model queue,
steer a running coordinator, reopen settled work, or notify its subscribers.
`result` wakes only a recipient subscribed to that sender's completion. An
explicit result consumes a one-shot subscription and suppresses the later
duplicate completion notice, including for ongoing subscriptions. Sender and
source run attribution come from the engine's validated claim proof.

An actionable `blocker` can wake a recipient. An explicit `task` can assign new
work to a worker. These intents do not override human Stop. Tool schemas and
responses explain delivery instead of claiming that every send starts work.

The last transcript also exposed a display-order defect: its initiating disk-full
report was rendered below later steering and completion notices. The initiating
machine message now precedes every response segment. The stored history already
had the correct order and is preserved. That exchange ended with disk cleanup
and builds on hold; the agents have not resumed feature work.

## Verification

Focused store/tool/socket and transcript regressions cover one-shot delivery,
explicit ongoing monitoring, Stop refusing agent traffic without adding history,
SQLite reopen and Stop receipt replay, default-hidden machine content, and
visible human steering. Existing web and engine suites were exercised; the two
socket expectations changed for the new one-shot default pass on rerun.
Browser verification of the development gallery confirmed collapsed defaults,
Markdown expansion, 800px/320px widths, 384px maximum expanded body height, no
horizontal overflow, and no browser errors. No paid provider turns are needed
for these checks.

Follow-up validation: 1,877 engine tests and 1,520 web tests pass, plus 68 client
tests; engine/web typechecks pass and lint has no errors (12 existing warnings).
New SQLite-backed regressions cover passive persistence and restart, no steering
or notification cascade, awaited versus unawaited results, duplicate suppression,
and Stop precedence. A transcript regression checks the initiating message appears
before later human steering. A tool regression checks the passive default.
