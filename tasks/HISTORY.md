# History

Completed delivery is distinct from functional acceptance.

## Repository cleanup

### REPO-001 — Remove obsolete documentation

- User explicitly requested deletion of the entire repository `docs/` directory.
- Owner: local Telar session `session_5942b1d49d6d4cac9bf58954684b74dc`.
- Status: completed; root verified directory absent and 19 tracked deletions. No symlinks or untracked files were inside. Deletions remain uncommitted.
- Preserve `tasks/` and all unrelated working-tree changes. No commit or push requested.


## Completed delivery / baseline

### DEV-001 — Prepare isolated local Mac Dev baseline

- Local branch `dev/local-dogfood` created from main `79370cb44d458d93e818409ff76b0fbab5a92395`; old release branch preserved.
- Artifact: `apps/desktop/release/dev/mac-arm64/Telar Dev.app`.
- Build, identity checks, engine/worker and bundled dependency smoke passed. No nightly replacement.
- Existing Dev home preserved. Initial dirty stamp came from generated `next-env.d.ts`; baseline checkout was restored clean before subsequent fixes.
- Interactive startup exposed DEV-003, so “baseline built” does not mean daily-use acceptance.

### DEV-002 — Test update of iPhone Dev

- `apps/ios/phone.sh` built and installed `com.telar.mobile.dev` from `79370cb4` onto the connected iPhone.
- Agent independently verified installed app and running app/extension processes. TestFlight nightly remained installed.
- Screen rendering and pairing were not inspected. No app uninstall/reset.

### RELEASE-001 — Six-feature nightly batch

- Delivery complete; functional acceptance reopened in REVIEW-001 through REVIEW-006 at the user's request.
- PRs #178–#183 merged: session pin/snooze/unread handling; TeX rendering; project icons and registry removal; editor workspace and blank lines; browser profiles and remembered agent fills; restart recovery.
- Published `v0.1.0-nightly.20260908.1` from `79370cb44d458d93e818409ff76b0fbab5a92395`.
- Build: https://github.com/Facundo-Barbera/Telar/actions/runs/34253143047 — succeeded.
- Hosted CI passed; local combined verification had the TEST-001 timeout, standalone engine suite passed.
- Manual-login trigger gap is tracked separately as AUTH-001. Unattended passkey support was not delivered.

## 2026-09-08 — Retired GitHub roadmap

At the user's request, closed as **not planned**: #93, #92, #91, #90, #89, #88, #67, #11 (Loom/Ultra/Warp roadmap), and #2 (floating desktop companion). Verified six issues remain open. These ideas are not part of the active backlog and will not be resurfaced unless the user requests them. No implementation code was removed by closing issues.
