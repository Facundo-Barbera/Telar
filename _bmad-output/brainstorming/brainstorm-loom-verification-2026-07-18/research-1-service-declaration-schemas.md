# Research 1 — Service Declaration Schemas (prior art survey)

> Scout report, 2026-07-18. Feeds the loom-verification brainstorm. Surveyed: docker-compose, process-compose, Procfile ecosystem (foreman/overmind/honcho), systemd, supervisord, Kubernetes, devcontainer.json, devenv.sh 2.0, mise/pitchfork, Tilt.

## B. Convergent minimal declaration set (the irreducible core)

- `command` (+ args)
- `cwd`
- `env` (map, possibly merged from a shared project env)
- **a readiness signal of some kind** — every tool that skipped it (supervisord `startsecs`, Procfile) is exactly where flakiness lives
- `depends_on` **with a condition**, not just ordering (`service_healthy`-equivalent) — every schema that added conditioned deps did so because ordering-only broke in practice
- **stop signal + grace timeout** (always as a pair)
- **restart policy** (explicit, even if `never`)
- **an ownership/scope token** binding the running process set to *this* project/run/directory

Not convergent (situational): data/volume declaration, seed/init as a distinct field, active port allocation (only devenv 2.0 and foreman/honcho do real allocation math).

## C. Readiness mechanisms — 9 distinct types

| Mechanism | Where found |
|---|---|
| HTTP GET poll | compose, process-compose, k8s, devenv, Tilt, pitchfork |
| Exec command / exit-code poll | compose, process-compose, k8s, devenv, Tilt, pitchfork |
| TCP socket connect | k8s, Tilt, pitchfork |
| gRPC health protocol | k8s only |
| Notify-socket self-reported ready (`sd_notify READY=1`) | systemd; devenv (`ready.notify`, explicitly modeled on it) |
| Watchdog heartbeat (continuous liveness ≠ initial readiness) | systemd `WatchdogSec`, devenv watchdog |
| Fixed time delay (no real check) | supervisord `startsecs`, pitchfork `ready_delay` — the weakest fallback |
| Log-output regex match | pitchfork `ready_output` (only first-class example) |
| Socket-activation pre-bind (ready by construction) | systemd `.socket` units |

k8s uniquely splits **three probe roles**: `startupProbe` (still booting — suppresses the others), `readinessProbe` (should traffic flow — no restart), `livenessProbe` (fundamentally stuck — kill & restart).

## D. Port allocation / collision

- Fixed developer-declared ports, no protection: compose, systemd, supervisord, Tilt
- `$PORT` injection with offset math: foreman/honcho (base + line-index×100 + instance)
- Random port + discovery command: compose (`ports: CONTAINER` alone → `docker compose port`)
- Metadata-only port, real exposure separate: k8s (`containerPort` documents; Service routes)
- **Automatic collision-avoiding allocation: devenv 2.0 `ports.<name>.allocate`** (built so concurrent shells coexist)
- Pre-bound socket: systemd socket activation
- Editor-side surfacing layer: devcontainer `forwardPorts`/`portsAttributes`

## E. Data/state · seed · teardown

- Managed state dirs with lifecycle policy: systemd `StateDirectory=` etc.; devenv `.devenv/state/<service>/`
- Seed/init as explicit phase: k8s `initContainers` (cleanest), systemd `ExecStartPre=`, compose/process-compose via `service_completed_successfully` one-off service, devenv service presets (`initialDatabases`), devcontainer lifecycle hooks
- Teardown dominant pattern: **graceful signal → grace timeout → SIGKILL**; supervisord's `stopasgroup/killasgroup` (whole process group, catches forked children) notably careful; devcontainer `shutdownAction` makes teardown-cascade an explicit choice

## F. Ownership / scoping tokens

| Mechanism | Tool |
|---|---|
| Project-name prefix on every resource | docker-compose (`-p` / `COMPOSE_PROJECT_NAME`) — N instances of same file coexist |
| Unix control socket per working dir | overmind `.overmind.sock` — also enables selective attach/restart of one process |
| Directory-enter/exit auto lifecycle | mise/pitchfork (`auto = ["start","stop"]`) — tightest dir-bound lifetime |
| cgroup slices / transient scopes | systemd (`systemd --user`, `systemd-run --scope`) |
| ownerReferences with cascading GC | Kubernetes — deleting the owner cascades to everything it owns; most explicit "owned by run X" |
| Editor-session-scoped teardown | devcontainer `shutdownAction` |

**The cross-cutting property** (what "run X" must guarantee, independent of mechanism): *given only the declaration plus one identifier, mechanically enumerate and tear down everything that run created, without touching anything from a different run of the same declaration.*

## Other clever bits worth stealing

- compose `condition: service_healthy` — readiness as a hard start-gate for dependents
- overmind: tmux-backed processes → `overmind connect <name>` attaches an interactive terminal to one running service (unique in survey)
- foreman `export` — compiles dev declaration to real init-system units
- Tilt `cmd` vs `serve_cmd` — explicit split of "prep step" from "the persistent process", with separate envs
- devenv 2.0: was built ON process-compose, then graduated to its own native Rust manager (a meta-schema becoming an engine — telar's likely trajectory too)
- supervisord `[eventlistener:]` — readiness gap acknowledged but pushed to plugins; the cautionary tale
- k8s `Job` vs `Deployment` — bounded-run vs always-on as distinct declared kinds
