# Local nightly runner

Nightly publishing uses the repository-scoped `facundo-mac-telar-nightly` runner
on Facundo's Apple Silicon Mac. Its custom label is `telar-nightly`; PR verification
continues to use GitHub-hosted runners. Dispatch **Nightly channel build** on `main`.
The Mac must be awake, connected, and logged into Facundo's macOS account. Hosted
Actions minutes are not needed for this job.

Installation: `/Users/facundo/actions-runners/telar-nightly`.
The official runner's LaunchAgent starts at login and receives automatic runner
updates. From that directory, use `./svc.sh status`, `./svc.sh stop`, or
`./svc.sh start`. Logs are in `_diag`. Do not commit runner credentials or copy
this directory into a repository.

The job uses a separate checkout and temporary build worktree. Signing credentials
come from existing repository secrets, are imported into a unique temporary
keychain, and are removed after the job. The prior user keychain search list is
restored. Publication remains serialized and uses the existing signed R2 nightly
feed. This runner does not change `/Applications/Telar.app`; install a published
nightly through Telar's updater.

Only trusted repository code should target this machine: a runner process has
Facundo's user permissions. Do not change pull-request workflows to use this
runner or run arbitrary branch workflows on it. To move publishing back to GitHub,
restore `runs-on: macos-14` after the hosted quota is available. Stop the service
before removing the runner in repository Settings → Actions → Runners.
