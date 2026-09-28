# Telar

Telar is a local engine that drives the coding agents already installed on the machine (Claude Code, Codex, OpenCode), plus the cockpit that controls it from the desktop app, a browser or an iPhone. It is the owner's daily driver. Keep it fast, keep it small, and keep every feature in one findable place.

The codebase is being moved to the layout in `docs/internals/architecture.md`, following the plan in `docs/migration/plan.md`. Read both before a structural change.

## Glossary

Use these words. When you name things in code, use them too.

- **you**: the agent reading this file. **The owner**: Facundo, the person you work for.
- **engine**: the local daemon (`apps/engine`). It owns all state and logic and serves the `/v2` HTTP API.
- **worker**: the engine process that claims turns and runs a provider. An engine has one worker embedded, or supervises one.
- **cockpit**: the UI (`apps/web`), shown in the desktop app, a browser or on a phone.
- **rail**: the cockpit's left list of sessions. **Panel**: the right pane. **Surface**: one thing drawn in the panel (diff, files, browser, terminal…).
- **Looks**: the cockpit's themes.
- **project**: a directory registered with the engine. **Checkout**: the project's own tree.
- **session**: one conversation with an agent on a project.
  - `local` means it works in the project's checkout.
  - `worktree` means it has its own git worktree and branch.
- **turn**: one message plus everything the agent did to answer it. **Run**: a turn's id.
- **journal**: the durable per-session event log (SQLite). **Items**: the rows the transcript is folded from.
- **provider**: an agent runtime (Claude Code, Codex, OpenCode). **Driver**: the engine code that runs one.
- **agent tools**: the MCP tools Telar gives agents (`sessions_*`, `notes_*`, `prompt_*`, `display_*`, `terminal_*`, browser tools). They are assembled once by `telarWall`.
- **request**: a permission prompt parked for a person (the permission gate).
- **steering**: a message sent into a turn that is already running.
- **settled**: a session shelved out of the active rail. **Snoozed**: shelved until a time.
- **peer / builder**: a session another session created to do work. **Orchestrator**: the session that tasks builders.
- **plugin**: an optional feature a project enables, such as Data Science or LaTeX, or an external plugin under `<TELAR_HOME>/plugins`.
- **host**: a Mac running an engine. **Device**: a paired phone or browser.
- **TELAR_HOME**: the engine's data directory. The live one belongs to the owner: never read, copy or write it.
- **nightly**: an automatic desktop or iOS build tagged from `main`.

## Where code lives

- `apps/engine`: engine and worker (Bun, TypeScript).
- `apps/web`: the cockpit (Next.js, React). Features call the engine through typed clients; the `/api/**` routes that forward those calls go away when the cockpit is static.
- `apps/desktop`: the Electron shell. It hosts the cockpit, the integrated browser, terminals, packaging and self-update.
- `apps/ios`: the native SwiftUI iPhone app and its Live Activity.
- `packages/engine-client`: the engine's protocol (zod schemas) and typed HTTP client. It is the only contract between the apps.
- `workers/push-relay`, `workers/updates-proxy`: Cloudflare Workers for push and desktop updates.

Every feature belongs to a **domain**: one folder, with the same name in every app. The domains are `sessions turns projects worktrees providers agent-tools plugins computer-use files git github terminal browser remote hosts push appearance settings dictation notes prompts usage schedules storage updates`.
- Engine: `src/domains/<name>/`.
- Web: `src/features/<name>/`.
- Contract: `packages/engine-client/src/<name>/`.
- iOS: `Features/<Name>/`.

The cockpit also has four UI-only features with no domain: `commands`, `composer`, `transcript`, `panel`.

Code that is not a feature goes in `platform/` (kernel, db, http, git, process), `ui/` (design system), or the engine's `drivers/` and `worker/`. A domain is imported only through its `index.ts`, or its `server.ts` for Node-only web code. If the folder you need doesn't exist yet, create it with that shape. Don't add a file to a directory root or to `state.ts`.

## The ways to hurt yourself

- **The owner's live data.** Never touch `~/Library/Application Support/Telar*`. Tests build fixtures in a temp dir.
- **Their running app.** Never restart, kill or update Telar or its processes (`telar-engine`, `telar-ui`). Never `pkill`/`killall`.
- **Secrets.** Never print or read keys, tokens or Keychain items (for example `com.telar.push-relay`).

## Taste

- Do not preserve complexity just because it already exists. Delete what you replace in the same PR.
- No file over 800 lines and no function over 150. When you touch an oversized file, extract the part you changed.
- A PR that only moves code must also delete something: dead code, a duplicate or a forwarder.
- No compat aliases without a removal date.
- Comments: none by default. Allowed only: at most 3 lines stating a non-obvious invariant or external quirk, or a 1–3 line usage note on an export. Never history ("previously", "#490"), never essays, never CAPITALIZED emphasis. When you touch code, trim the stale comments next to it.
- UI copy: a setting explains itself in one sentence; facts that can't be inferred go behind the row's ⓘ; no third-party product names.
- Bun only, never npm. Change `package.json` and lockfiles only through `bun add`/`remove`/`install`.

## Verifying

- Prove the smallest thing. Run the tests you touched (`bun test path/to/file.test.ts` inside the workspace), `bun run check:source`, and typecheck for the workspace (`bun run --cwd <ws> typecheck`). CI runs the full suites.
- Tests sit next to the file they test (`archive.ts` → `archive.test.ts`), integration tests included. `test/` folders hold only shared helpers and fixtures.
- Test behaviour: what renders, what a click or keypress does, what the engine returns. Never assert on source text, class strings or wiring.
- No real-timer sleeps. Use fake timers, or wait on the event you expect.
- Don't start long-running processes (dev servers, Electron, simulators, watchers). The owner tests the app themselves.
- CI checks enforce the rules above: `check:source` (comment ratchet, invariants), `knip`, `lint:ox`, and the size limits.

## Documentation

Most changes need no documentation. Agents can read the code.

- `docs/user/`: how to use a feature. One concise section per feature: what it does, how to start, what is unintuitive.
- `docs/operations/`: developing, releasing and debugging Telar.
- `docs/internals/`: decisions and constraints that span components, and traps that are hard to find in the source. Before adding a paragraph, ask what a maintainer would get wrong without it.
- Don't document every feature, list files or methods, narrate control flow, or append PR summaries. When a documented decision changes, rewrite that text; don't append another account.
- Don't commit plans, research notes or scratch files. Work-in-progress lives in the issue or the PR.

## Pull requests and commits

- Branch from `origin/main`. Small PRs; never stack them (merging deletes the head branch).
- Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`), one logical change each, with a message that says why.
- The PR says what changed, what you tested, and its net code lines.
