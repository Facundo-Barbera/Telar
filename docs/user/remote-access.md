# Remote access

Telar runs on your Mac, but you can reach it from somewhere else: a browser on another computer, the iPhone app, or the Telar on a second Mac. Everything is in Settings → Remote access.

## How it's guarded

**Require pairing** is on by default. A device can only connect once it's paired. The Mac running Telar is always allowed in. If you turn pairing off, anything that can reach the address has full control.

**Network access** decides who can reach Telar at all. By default Telar only listens on this Mac. Switch it to every interface to let other devices on your network or tailnet connect. This setting only applies while Require pairing is on, and it takes effect when Telar restarts. The pane offers a Restart button.

## Pairing a browser or phone

1. On the Mac, go to Settings → Remote access → Pair a device and show a pairing code.
2. Pick the address the other device will use: the local network, your Tailscale address, or the Tailscale HTTPS name.
3. On the other device, scan the QR code, open the link, or type the eight-digit code on the pairing page.

A code works for one device. It lasts five minutes or five wrong tries, and Telar shows it once and never stores it.

A browser pairs once per address. If you've paired at the Tailscale IP, the Tailscale HTTPS name counts as a different address and needs its own pairing.

## Tailscale

Tailscale is the easiest way to reach your Mac from anywhere. Install it on the Mac and on the other device, and sign in to the same tailnet. Then pick the tailnet address when you pair.

**Tailscale HTTPS** publishes Telar at a MagicDNS `https://….ts.net` address with a real certificate. Some browser features, like dictation, only work over HTTPS on a phone's browser. To use it, turn on HTTPS certificates for your tailnet in the Tailscale admin console. It takes effect at the next launch.

Before you turn it on: issuing the certificate writes this Mac's name to a public certificate log, permanently. If the Mac's name includes your own name, rename the machine in Tailscale first.

## Paired devices and roles

Every paired device is listed with where it connected from and when it was last seen. Each has a role:

- **Full**: reads and changes everything, like the Mac itself.
- **View only**: reads everything and changes nothing. A view-only phone can't sign up for notifications.

You can rename a device or change its role. At least one device must keep full access.

## Revoking

Revoke a device and it's logged out on its next request. It can pair again with a fresh code. **Revoke all other devices** logs out everything except the device you're using. Use it if you lose your phone.

Forgetting the pairing on a phone only removes it from that phone. To cut the phone off everywhere, revoke it on the Mac.

## Other Macs

You can bring another Mac's conversations into this one's rail.

1. On the other Mac, turn on network access and pairing, then show a pairing code and copy the link.
2. On this Mac, go to Settings → Remote access → Other Macs, paste the link, and choose Pair.

That Mac's conversations appear in your rail, marked with its name, and you work on them from here. You can rename it here.

Its alerts show on this Mac too, with this Mac's sounds, but only while you are using this Mac and not the other one. While this Mac is in use, the other Mac's phone push is held back as if it had shown the alert itself.

Forgetting a Mac removes its conversations from your rail. The other Mac still lists this one as a paired device until you revoke it there.

## Push notifications

Phone notifications are also set in Remote access. See [iPhone](iphone.md).
