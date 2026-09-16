/**
 * Preloaded before every engine test — issue #532. THE SUITE DOES NOT TALK TO A
 * REAL PROVIDER.
 *
 * WHAT WENT WRONG WITHOUT IT. `daemon.ts` retitles a session on its first turn,
 * the default text-generation policy has `titles: true`, and a test store is a
 * `mkdtemp` directory with a real signed-in `claude` on PATH. The fixture
 * messages ("Hello", "Long task", "Stop me") are seed titles, so the check that
 * guards the call passed every time: each run of this suite made dozens of real
 * model calls on whoever's subscription was logged in, and Claude Code saved a
 * ~250 KB transcript for each. 41,937 of them (8.2 GB) were found under
 * `~/.claude/projects/-private-tmp/`, growing at up to 9,311 a day against 22
 * real sessions. The model and skills probes reach the SDK the same way.
 *
 * TWO SWITCHES, BOTH READ AT CALL TIME so a single test can flip one around one
 * assertion: `TELAR_TEXTGEN=off` stops the generation policy acting (see
 * `textGenDisabledByEnv`), and `NODE_ENV=test` arms `refuseCliSpawnUnderTest`,
 * which every provider spawn resolves its binary through. A test that genuinely
 * needs a CLI opts in with `TELAR_ALLOW_CLI=1`.
 *
 * REGISTERED IN apps/engine/bunfig.toml AND in the root bunfig.toml: bun reads
 * bunfig.toml from the directory it was invoked in and does NOT walk up, so
 * `bun run --cwd apps/engine test` and a bare `bun test` at the repo root each
 * need their own registration. scripts/test-setup.mjs says the same about the
 * web preloads.
 */

/**
 * NODE_ENV FIRST, because the gate is keyed on it and it is not reliably "test"
 * here. bun sets it only when it is unset, and Telar's own engine runs with
 * NODE_ENV=production — an agent session it spawns inherits that, so a suite run
 * from inside the app would otherwise arrive with the gate disarmed. Only
 * "production" and "unset" are rewritten; any other value was asked for
 * deliberately. Nothing in apps/engine reads NODE_ENV for its own behaviour.
 */
if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === undefined) process.env.NODE_ENV = "test";

/** Unconditional, not a default: an inherited `TELAR_TEXTGEN=on` from somebody's
 *  shell would silently restore the exact bug this file exists to stop. */
process.env.TELAR_TEXTGEN = "off";
