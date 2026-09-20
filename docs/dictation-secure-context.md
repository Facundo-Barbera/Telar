# Dictating into a Telar cockpit that is not on this Mac

Cited by `apps/web/lib/dictation/refusal.ts` and `apps/web/lib/dictation/use-dictation.ts`,
which produce the sentence a person sees when this happens. Written for #639.

---

## The symptom, and the thing that is actually true

Open the cockpit on the Mac it runs on and dictation works. Open the same
cockpit from a phone, a tablet or another laptop — `http://100.x.x.x:PORT`
over the tailnet, or a LAN address — and the mic is unavailable.

`navigator.mediaDevices` does not exist there. Not "is denied", does not
exist: browsers expose it only in a **secure context**, so the guard in
`use-dictation.ts` (`canRecord`) correctly answers that this page cannot
record. Until #639 that produced no button and no bound chord, which is why
this read as a feature that silently broke rather than one with a cause.

## Settled — please do not re-litigate

- **No header, server flag or permission policy grants microphone access
  outside a secure context.** There is no `Permissions-Policy` value, no
  response header and no Telar-side setting that changes this.
- Chromium has an open request for a flag treating private IP ranges as
  trustworthy — [issue 41239332](https://issues.chromium.org/issues/41239332)
  — and it **has never shipped**.

## The insight this all turns on: a secure context is not a certificate

[W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/) returns
*Potentially Trustworthy* for any origin whose host matches `127.0.0.0/8` or
`::1/128` — **with no certificate at all**. That is exactly why dictation
already works on the Mac: the cockpit is on `127.0.0.1` and the browser treats
it as secure without anyone signing anything.

So the question is not "how do we get HTTPS to the phone". It is **"how does
Telar appear on the localhost of the device that wants to dictate"**.

> **Carry this caveat rather than rediscovering it.** The spec marks that
> loopback carve-out **"at risk"**. It is unlikely to move — much of the web's
> tooling stands on it — but it is not a permanent guarantee, and everything
> below rests on it.

---

## 1. The answer today, for machines you already have access to: `ssh -L`

An SSH local forward makes the Mac's cockpit answer on the *client device's own*
loopback address. The browser then sees `http://127.0.0.1:PORT`, which is a
secure context, and dictation works — no certificate, no public ledger entry,
**and no change to your network**.

**Find the port** in Settings › Remote access: the "This machine" row prints
`http://127.0.0.1:PORT`. It is chosen per install rather than fixed, so read it
rather than assuming 3000.

**From the client machine** (a second laptop, a Linux box — anything with an
SSH client):

```sh
ssh -N -L 7788:127.0.0.1:PORT you@your-mac
```

Then open `http://127.0.0.1:7788` on that machine. `-N` means "forward only,
run no command". The local port (`7788`) is arbitrary; the remote one must be
the cockpit's.

### What this changes, and what it deliberately does not

- **It does not require Network access to be on.** SSH connects to
  `127.0.0.1:PORT` *from the Mac's own side*, so this works with Telar still
  bound to loopback only — the mode where nothing else on the network can reach
  it at all. This is strictly *less* exposure than the tailnet-IP path most
  people use today, not more.
- **It does not bypass pairing.** `lib/remote/gate.ts` decides on the host
  token and the device cookie, never on the source address, so a tunnelled
  browser pairs exactly like any other device. Arriving on loopback buys the
  secure context and nothing else.
- **It does not need Telar to change.** This works against what is shipping.

### The honest limitation

**This is a desktop answer.** iOS and iPadOS have no built-in SSH client, so a
phone needs a third-party terminal app (Blink, Termius) holding a key, with the
tunnel alive in the background while you dictate. That is a worse experience
than it sounds and is the reason a *product* forwarder is still wanted — see
§4.

---

## 2. The zero-cost fallback that works over plain HTTP right now

Do not record in the page at all. Nothing needs a secure context if the browser
never touches the microphone:

- **The OS keyboard's own dictation.** The composer is a plain editable box, so
  the iOS keyboard's mic key, macOS dictation and Wispr Flow all type into it
  today, over plain HTTP, on any address.
- **`window.telar.dictate(text)`** (#548, documented in
  [`page-api.md`](page-api.md)) — an external client captures audio wherever it
  likes and hands Telar only text.

**State the limitation plainly when you recommend this:** neither route carries
the Mac's project vocabulary or keyterms (#581), which Telar's own dictation
sends to the provider to prime the recogniser. Names, paths, issue references
and Spanish/English code-switching are exactly what those terms exist to fix, so
transcription through the OS keyboard is genuinely worse — not merely different.

---

## 3. Real HTTPS via Tailscale — and the cost you must read before clicking

Tailscale Serve gives a genuine certificate and therefore a secure context, and
Telar already has the toggle (Settings › Remote access › "Tailscale HTTPS").

> ### Read this before enabling it
>
> **Enabling HTTPS certificates publishes your machine's DNS name to a public
> Certificate Transparency ledger — permanently and irreversibly.** CT logs are
> append-only and globally searchable; there is no delete.
>
> The tailnet portion of the name is randomised to obfuscate the organisation.
> **The machine name is not.** A default macOS machine name is built from the
> account's full name, so the published record can carry your surname forever.
>
> **Rename the machine first** if that matters to you — in the Tailscale admin
> console, before the first certificate is issued. Discovering this inside
> Tailscale's own confirmation dialog is too late.

And the standing constraint that governs every recommendation on this page:
**we do not require anyone to change their network to use our app.** Tailscale
is a legitimate option for someone already running it. It is not the answer to
"dictation does not work on my phone", and it must never be the first step of a
guide.

---

## 4. What is not built yet

A **local forwarder as a product** — something Telar ships that runs on the
client device, listens on its loopback, and speaks to the Mac behind it — is the
general form of §1 without the SSH prerequisite. It is deliberately not in
#639: it is the same shape the relay work needs
([`investigations/627-remote-access-without-tailscale.md`](investigations/627-remote-access-without-tailscale.md)),
and building it twice would be the mistake. It should be built once, there.

What #639 landed instead: the cockpit now **says** why it cannot record, with
the route out, rather than drawing nothing — and this page is the long form of
that sentence.
