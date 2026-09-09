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

This is not a global rate limiter or a new inbox protocol. Explicit agent sends
can still start work in sessions that the user has not stopped. Agents should
subscribe only to outcomes they are awaiting and communicate actionable changes.

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
