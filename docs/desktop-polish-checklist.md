# Desktop release candidate — September 6, 2026

Scope: sessions, project navigation, browser, 1Password and release reliability. Release candidate prepared on `experiment/work-surface`. This supersedes the old checkpoints describing the obsolete always-scaled viewport.

## Implemented behavior

- Project sidebar, larger left-aligned rows, settled project icons, removed Settings session entry, matched headers and traffic-light inset.
- Rounded independent surfaces and animated right panel with expansion/restoration.
- Browser drafts preserve text/settings and defer worktree allocation until first send.
- Per-project browser profiles; per-session tabs survive restart and remain usable by agents in the background subject to the live-view budget.
- Fit is the default: visible Fit uses native bounds, no device emulation or presentation zoom. Hidden Fit retains its last meaningful viewport. Explicit fixed sizes use emulation and resize rails.
- No device frame on Fit or blank tabs. New tabs show project history and discovered local servers.
- Successful replacement navigation can recover from ERR_ABORTED; actual failures remain errors.
- Usage has matching borders, loading feedback, range caching and stale-request protection. Global and project Settings use the same rounded-panel shell.
- A sign-in never pauses browser tools: neither the 1Password popup nor a credential field gates, delays or refuses an agent's call, and there is no control banner (#524). Extension pages stay outside agent capture.
- Release smoke and engine-worker checks precede upload; immutable artifacts precede feeds.

## Final review

- Archived the abandoned workspace preview and canvas helpers outside the repository; removed their app-shell special case.
- Restricted native browser bridge selection to local host routes. Remote sessions must not use this computer's browser/cookies.
- Pinned draft creation/settings and browser startup requests to their originating host; stale errors cannot appear in another conversation.
- Final runtime findings and validation results are in the release review report. Older test totals are not evidence for later code.

## Acceptance standard

Run `bun run verify`, package smoke and deep strict signature verification. Then inspect the actual signed app through computer use. Unit tests alone are not visual acceptance.

Electron harnesses: browser regression, persistence, credential frames, popup geometry, and `browser-fit-zoom.electron-test.js`. The Fit harness reads without repairing geometry and checks actual rendered pixels, native zoom, visual scale, fixed-to-fit changes, repeated resizing, click coordinates and hidden retention.

Native checks: blank tabs, fitted/fixed resizing, session switching, drafts, restoration, Usage and sidebar controls. The unsigned shell and signed installed app are different acceptance surfaces.

## 1Password limitation

The signed Dev app has displayed an unlocked extension and previously completed user-driven sign-in. The latest stalled popup recovered on close/reopen without copying or filling items. Logs showed an AppIntegration account-request failure while helpers stayed alive; cause remains unproven.

A live helper is not proof of a profile's authenticated connection. Unsigned Electron may be rejected by the helper. Sustained lock/unlock and restart acceptance remains a release-confidence gate.

## Nightly scope and remaining acceptance

1. Owner confirmed September 6: this is a personal project, and the nightly is installed only on their own machines. No third-party distribution is authorized. Revisit the GPL/Patron decision before distributing to others.
2. Extensions are enabled for personal nightly and Dev builds. Beta/stable remain opt-in. `TELAR_EXTENSIONS=0` disables them for troubleshooting.
3. Existing shared browser logins are not migrated automatically. Projects use fresh isolated profiles; users sign in again through 1Password. Never assign old shared cookies to the first project automatically.
4. Review/commit the final candidate and validate its exact revision.
5. Test an actual nightly upgrade with existing data, production signing identity and 1Password approval. Dev installation is not that evidence.
6. Stable also needs version/channel/feed support and upgrade validation; current tooling accepts beta/nightly only.

The owner authorized cleanup and nightly publication. Stable release and third-party distribution remain outside this scope.
