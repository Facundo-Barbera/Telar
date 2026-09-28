# Permissions and requests

When an agent wants to do something its access mode doesn't allow, it asks and waits. That pause is a request. The session shows "Waiting on you" in the rail until you answer.

## Kinds of request

- **Commands**, **file changes**, **file reads** and **tool calls**: approvals. The card shows the command, the diff, the path or the tool input.
- **Questions**: the agent needs an answer from you. The question opens above the composer. See [Composer](composer.md).
- **Secrets**: the agent asks to fill a login in the integrated browser from your password manager. See [Integrated browser](browser.md).

## Access modes

Which approvals reach you depends on the session's access mode:

- **Supervised** asks for everything except reading files.
- **Auto-accept edits** also lets file edits through.
- **Auto** lets routine actions through.
- **Full access** never asks.

Questions and secrets always wait for you, whatever the mode. Switch mode from the composer or with `/supervised`, `/auto-edits`, `/auto` or `/full-access`. The default for new sessions is in Settings → General → New sessions → Access.

Tools that plugins add always ask, unless Telar itself knows the tool only reads.

## Answering

An approval offers Allow once, Always allow (for this session) and Deny. When you deny a request, the agent is told, and it can try something else.

A question can be answered or cancelled. Cancelling ends the whole turn.

## From the iPhone

Requests reach the iPhone as notifications. An alert for a single approval has an Approve action, which needs Face ID or your passcode. It approves only the request the alert named, so an old alert can't approve a newer one. Questions and secrets have to be answered in the app. In the app you can also decline with a reason, which is passed back to the agent. See [iPhone](iphone.md).

## When nobody answers

A request waits as long as it takes. If the card says it was parked with nobody watching, no notification went out, so check your notification settings.

## Sessions answering for you

A coordinating session can answer an approval that one of its workers is waiting on. Telar records that a session answered, not you. A session can never choose a secret for you. See [Agents working together](agents-together.md).

## Sessions started by agents

A session that another session creates never gets a wider access mode than its creator had at that moment.

## Computer use

Letting agents operate other apps on the Mac is a separate matter. It needs macOS permissions (Accessibility and Screen Recording), which you grant and test under Settings → Agent tools → Computer use.
