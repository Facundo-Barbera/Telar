# iPhone

The Telar iPhone app follows your agents while you're away from the Mac. You can read live conversations, answer requests, send new messages and review the work. It also runs on iPad. The agents keep running on the Mac, so the Mac has to stay awake with Telar open.

## Getting connected

1. On the Mac, go to Settings → Remote access. Make sure your phone can reach the Mac: use the same Wi-Fi, or Tailscale on both devices (see [Remote access](remote-access.md)).
2. Show a pairing code, and pick an address the phone can reach.
3. In the app, choose **Scan pairing code** and point the camera at the QR code. You can also paste the pairing link, or choose **Connect manually** and enter the address.

To add more Macs, go to Settings → Add a Mac… in the app. Each Mac pairs separately. Conversations from all of them share one list, and you can filter it by Mac.

If a connection fails, check the obvious things first. For a local address, the phone must be on the same Wi-Fi and allowed to use the local network. For a 100.x address, Tailscale must be connected on the phone.

## What you can do from the phone

- Browse conversations the same way as on the Mac: needs you, pinned, by project, snoozed and settled. You can search too.
- Start a conversation in any project, choose the model, and attach photos.
- Reply, queue a message, or send one into a running turn without stopping it. You can also stop a turn.
- Answer approvals and questions from agents.
- Pin, snooze, settle, rename or delete conversations. In a conversation, **Archive** in the ⋯ menu settles it.
- Open the **Panel** to see the diff and browse files. Markdown and text files can be edited. Data and LaTeX show up when the project uses those plugins.
- Dictate into the message box, and have the last reply read aloud (Speak the last reply).
- Check a Mac's usage for the day, week or month.
- Manage paired devices under Settings → Devices, if the phone has full access.
- Use **Open on Mac** to hand a conversation over to the Mac.

## Notifications

In the app, go to Settings → Notifications & activities and turn on Notifications. iOS asks for permission at that point.

- By default you're alerted when a session needs you or fails. **Work completed** adds an alert when a turn finishes.
- Session titles are hidden in notifications unless you turn on **Show session titles**.
- To mute a single conversation, use its menu.
- Some alerts let you approve a request right from the notification.

There's nothing to set up on the Mac. The phone registers itself when you turn notifications on. The Mac then sends a test notification, and Settings → Remote access → Push notifications on the Mac shows whether it arrived. If the phone shows as not registered, open Telar on it.

**Notify on** (on the Mac) chooses where alerts go. The default sends them to the Mac while you're using it and to the phone once you step away. You can also choose iPhone only, or Both. Neither device alerts you about a conversation you're looking at.

Notifications need a real iPhone that passes Apple's app check. If the app says notifications can't be set up on this device, everything else still works.

## Live Activity

When a Mac has agents working, a Live Activity appears on the Lock Screen and in the Dynamic Island. It starts on its own, even with the app in the background. Each Mac shows one card that covers all its active sessions, with anything that needs you shown first. When the work finishes, the card shows Finished for five minutes and then leaves; work that starts again in that time reuses the same card.

You can turn it off with **Automatic Live Activities** in Settings → Notifications & activities. That screen also explains why a card isn't showing.

## Unpairing

Remove this Mac (in the app's settings) forgets the pairing and any unsent drafts on this phone only. To cut the phone off everywhere, revoke it on the Mac.
