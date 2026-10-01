# Security

Telar runs agents that can execute commands and write files, so whoever can reach it can act on the host. These invariants hold across every refactor:

## Access

- Only `ping` and `pair` are open without credentials. Everything else needs the engine token (loopback only) or a paired device token.
- The engine token never reaches a browser, renderer or phone. Desktop injects it on the cockpit's behalf, and remote clients use device tokens.
- Device tokens are stored only as sha256 hashes and compared in constant time. Deleting `remote/remote.json` is the lockout recovery.
- Pairing codes are 8 digits, valid 5 minutes, allow 5 tries, work once, and travel only in the URL fragment.
- Roles: `full` or `observer`. Observers get GET and HEAD only, with an empty write allowlist, and cannot change their own role. The last full-access device cannot be demoted. Fresh installs require pairing.
- A network listener sends no permissive CORS headers and checks the Host header, to block DNS rebinding.
- Another Mac's token stays on this Mac; a browser only ever sees our own origin.

## Agents

- Permission modes are capped by whoever created the session. A session can't hand a peer more access than it has.
- Login grants for the integrated browser are written by the desktop shell, never by the engine, so an agent can't grant itself a login.
- External plugins run as separate processes, and their tools always go through normal approvals. They are never treated as read-only.
- An inline artifact is agent-written html. Its frame is `sandbox="allow-scripts"` and never `allow-same-origin`, so it runs in an opaque origin with no reach into the cockpit, its cookies or its tokens. Its document opens with a CSP of `default-src 'none'`, so nothing leaves it. Svg and mermaid are drawn only as an image (a CSS background) of a `data:` url, where the browser runs no script and loads nothing; their markup is never put into the cockpit's DOM. The engine stores every artifact as `text/plain`, so the attachment route can't serve one as a page on the cockpit's origin.
- Relay send keys stay on the Mac. The push relay only ever returns Apple's reason word, never a provider body or a token.

## Data

- `TELAR_HOME` is the owner's. Tests and agents build fixtures in temp dirs.
- Secrets live in the Keychain (`com.telar.push-relay`) or the provider's own config. They are never logged or journaled.
