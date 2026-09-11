# Worktree map — 2026-09-10

Started at 48 registered Telar worktrees. Everything removed today was merged into
main or contained in another branch, with no unique commits. Uncommitted work from
the removed checkouts is saved under
`~/Library/Application Support/Telar/diagnostics/worktree-wip-2026-09-10/`
(one `.patch` per superseded draft, one `.tgz` per artifact-only checkout).

## Removed

- 11 merged, unowned checkouts (t3code, ~/telar-worktrees, engine root).
- 11 merged checkouts owned by idle sessions.
- 2 merged checkouts of other repos parked under Telar's engine root (lintel, NuSkills).
  A third, ozom-gv's `please-talk-to-me-about-…-f1d1d9`, was removed by mistake: its
  branch was merged into ozom-gv's main but the coordinator session …473b29 was still
  using it and failed five turns. Restored at the same path on the same branch.
  Lesson: "merged" is not "unused" — check the owning session's activity, not only git.
- 4 superseded drafts, patches saved, branches deleted (each had 0 commits not on another ref):
  run-198 (Run surface draft of Sep 9; main's landed Sep 10 via #225),
  plugins-191 (plugin host draft, same), session-inbox (`markSessionRead` +
  `/read` route, both in main), remember-manual-login (older `login-offer.js`).
- 5 checkouts whose only dirty files were fixtures, diagnostics, or investigation
  docs (saved as tgz): deep-audit, fix-fullscreen-207, fix-session-pinning,
  investigate-opencode-205, fix-fixed-viewport (all its commits are on the iOS branch).

## Sessions whose checkout is now gone (archive them; a new turn would run in a missing cwd)

browser-profiles …e34d0e · deep-audit …e53d68 · fix-fullscreen …e796e9 ·
fix-session-pause …05bb9a · fix-session-pinning …94885b · cut-stable-release …97cf2b ·
enable-independent-tabs …25b12a · add-markdown …3e4e6b · investigate-opencode …5b6042 ·
investigate-restart …6eeb58 · restore-session-tools …8dfa97 · persistent-editor …26010d ·
project-icon …631f90 · render-tex …3b1b5d · fix-machine-pairing …391c28 · fix-fixed-viewport …9b340e

## Kept — decide next turn (all local-only, no remote, no PR)

**A. `fix/ios-reconnect-responsiveness`** — the checkout on disk and the iOS
integration branch. 41 commits ahead of main, never pushed, no PR. It already
carries cherry-picks from several branches below (sidebar rows, auto-scroll iOS
half, wake-streaming iOS half, multi-select iOS). Decision: push + PR, or fold
into main.

**B. 16 session branches with unmerged commits of their own** (own = commits not
on main and not on the iOS branch):

| branch (slug) | own | what it is | size |
|---|---|---|---|
| multi-select-questions-contract-field-mu-88d819 | 3 | contract `multiple` + Claude/Codex arms; merge FIRST | 1.1G |
| multi-select-questions-on-the-web-compos-a53739 | 4 | web drawer + form card; merge after contract, drop shim | 1.1G |
| multi-select-questions-on-ios-field-deco-72e051 | 2 | already cherry-picked onto iOS branch → checkout removable | 1.1G |
| sidebar-rows-unread-done-marks-on-both-c-329711 | 5 | 4 iOS commits already on iOS branch; web dot `ab2a8c3a` is not | 2.6G |
| fix-auto-scroll-stops-following-in-some--c73f2b | 4 | 2 iOS on iOS branch; 2 web fixes not | 656M |
| investigate-replies-to-wakes-arrive-in-o-346e72 | 3 | iOS pacer on iOS branch; docs commit not | 20M |
| engine-idle-cpu-profile-the-100ms-worker-77c3ce | 8 | perf: queue cache, slower idle loop, prepared statements | 20M |
| agent-to-agent-messages-arrive-as-a-shor-827270 | 3 | engine+web: agent message reaches model as a notice | 20M |
| engine-a-move-notebook-edit-that-keeps-a-4ae169 | 3 | notebook cell move keeps outputs | 20M |
| fix-the-browser-s-credential-privacy-hol-2015f2 | 3 | desktop: privacy hold no longer locks every session | 21M |
| make-the-session-s-open-button-a-split-b-169815 | 7 | web/desktop: Open split button remembers editor | 20M |
| one-session-action-menu-definition-rende-6f8101 | 3 | web: one session action menu definition | 296M |
| redesign-the-composer-model-picker-two-l-1704c3 | 3 | web: model picker rows, ⌘-digits | 20M |
| settings-search-to-focus-results-jump-to-08fc00 | 3 | web: `/` settings search | 185M |
| settings-copy-discipline-hints-on-the-ro-0091a7 | 12 | docs(web): settings copy | 20M |
| fix-switching-sessions-lands-at-the-top--98b5d7 | 1 | web: session opens at its end | 20M |

**C. Other repos under Telar's engine root** — 5 ozom-gv checkouts, ~6.5G, owned
by sessions still *working*. Not Telar's; left alone.


## Update — 2026-09-11 (second pass)

All 18 remaining Telar checkouts removed: every one was clean, and its owning
session idle. Branches kept. Merged into main since the first pass, via #227
(iOS), #228/#229 (multi-select), #230 (keyboard + Back freeze): the three
multi-select branches, the iOS freeze branch, and the iOS halves of the
auto-scroll, wake-streaming and sidebar-rows branches (as cherry-picks).

Open PR #231 (`fix/web-session-switch-scroll`) carries the web halves of
`fix-switching-sessions…` and `fix-auto-scroll…`. Once it merges those two
branches hold nothing main lacks.

### Branches still carrying work main lacks (no checkout; recreate with
`git worktree add <path> <branch>` or open the session, which will fail its
next turn until then)

| branch (slug) | own commits | what |
|---|---|---|
| engine-idle-cpu-profile-the-100ms-worker-77c3ce | 8 | perf: queue cache, slower idle loop, prepared statements |
| settings-copy-discipline-hints-on-the-ro-0091a7 | 12 | docs(web): settings copy |
| make-the-session-s-open-button-a-split-b-169815 | 7 | web/desktop: Open split button remembers editor |
| agent-to-agent-messages-arrive-as-a-shor-827270 | 3 | engine+web: agent message reaches model as a notice |
| engine-a-move-notebook-edit-that-keeps-a-4ae169 | 3 | notebook cell move keeps outputs |
| fix-the-browser-s-credential-privacy-hol-2015f2 | 3 | desktop: privacy hold no longer locks every session |
| one-session-action-menu-definition-rende-6f8101 | 3 | web: one session action menu definition |
| redesign-the-composer-model-picker-two-l-1704c3 | 3 | web: model picker rows, ⌘-digits |
| settings-search-to-focus-results-jump-to-08fc00 | 3 | web: `/` settings search |
| sidebar-rows-unread-done-marks-on-both-c-329711 | 1 | web: unread dot on a session row (`ab2a8c3a`); its iOS commits are in main in newer form |
| investigate-replies-to-wakes-arrive-in-o-346e72 | 1 | docs: why iPad replies to wakes arrive in one block |
| investigate-read-the-agent-s-last-messag-2ab69c | 1 | docs: iOS talkback investigation (copied into main's tree, uncommitted) |

### Other repos under Telar's engine root — left alone
Six ozom-gv checkouts, ~6.6G. Two of their sessions are working right now
(`H2 integrador`, `Review milestone 2 issues`); the rest are idle but unmerged.
Those belong to the ozom-gv project's own cleanup.
