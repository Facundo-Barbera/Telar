# `window.telar` — the page API for external clients

Cited by `apps/web/lib/page-api.ts`. Added in #548 for the Quest cockpit
(telar-vr), which runs this web app in a WebView, captures the headset
microphone on push-to-talk, transcribes it, and has to put the resulting text in
the composer. That client can run JavaScript in the page and nothing else: no
extension, no bridge, no second origin.

**These three calls insert and never retract, and that is a boundary rather than
an omission.** An API that could reach back and delete a run of the draft could
delete what the *person* last typed — the composer is a live box, and a
dictation is not the only thing going into it. So a client holding a live
transcription that revises itself should write only phrases it has settled on;
each `dictate` continues the sentence rather than replacing it.

The composer's own mic button (#544) does rewrite its unconfirmed words in
place, and it reaches a `replace` on the composer registry underneath this file
to do it — not through here. In-process callers get the sharper tool; this
shape is what external clients are promised and it does not move.

Everything here is something the person at the keyboard could do with their
hands. There is no engine access, no reading of other sessions, and no way to
send anything the composer's own guards would refuse.

## The three calls

Installed on every route and on every host — this is the web app, not the
desktop shell, so a browser tab has them too. The object is frozen.

```js
window.telar.composer()
// → { id: "turn-prompt", kind: "session", draft: "fix the ", focused: true }
// → null when no composer is on screen

window.telar.dictate("failing test")
// → { ok: true, draft: "fix the failing test " }
// → { ok: false, reason: "No message box is on screen to type into." }

window.telar.dictate("ship it", { submit: true })
// → { ok: true, draft: "ship it ", submitted: true }
// → { ok: true, draft: "ship it ", submitted: false, reason: "…" }

window.telar.submit()
// → { ok: true }
// → { ok: false, reason: "There is nothing to send." }
```

**`composer()`** reports what `dictate` would write into, so a client can decide
before it speaks. `focused` says whether the caret is in the box right now;
`dictate` works either way.

**`dictate(text, opts?)`** inserts at the caret of the active composer through
the editor's own insertion path, so spacing and chips behave as they do for a
paste — a dictated word arrives spaced like a typed one, and a path or an issue
reference draws as a chip. Focus and the caret are left after the inserted text,
so a second call continues the sentence. The returned `draft` is what the box
holds afterwards, which is exactly what a send would carry.

With `{ submit: true }` it sends after inserting. **An insertion that landed is
never reported as a failure**: if the send is refused — a session that is not
ready, a project whose files are not reachable — the result is still `ok: true`
with `submitted: false` and a reason, and the words stay in the box for the
person to look at. `ok: false` means nothing was inserted.

**`submit()`** is the send on its own, for a spoken "send it". It passes exactly
the guard the Enter key passes, in the composer's own code rather than a copy of
it: a non-empty draft, a ready conversation, a reachable project — and, while a
question drawer is open, answering that question, which is what Enter does there.

Every refusal `reason` is a sentence, because a client's only move is to show it
to a person.

## The active composer

The most recently focused composer, falling back to the only one mounted. Two
composers exist — the session one and the Agent screen's — and they are
different routes, so in practice one is on screen. `composer()` is how a client
tells which.

## The two stable attributes

On the editable root, for a client that would rather select the element itself:

| Attribute | Values |
| --- | --- |
| `data-slot="composer-editor"` | the message box's editable root |
| `data-composer` | `"session"` or `"agent"` |

The session composer also keeps `id="turn-prompt"`; the Agent screen's is
`id="agent-prompt"`.

```js
document.querySelector('[data-composer="session"]')
```

## What is stable

The three call names and their result shapes, and the two attributes above.
Changing any of them breaks an external client's build, so change them the way
you would change a wire protocol.

The composer's markup around them is **not** stable: it is a `contentEditable`
whose draft is a string painted into chip elements (see
`apps/web/components/composer-editor.tsx`), and reading text out of that DOM, or
writing into it with `execCommand`, is the thing this API exists to stop anybody
having to do.
