/**
 * Preloaded before every `bun test` in this repo. Registered in bunfig.toml and
 * in apps/web/bunfig.toml — bun reads bunfig.toml from the directory it was
 * invoked in and does NOT walk up to the repo root, so each place tests are run
 * from needs its own registration.
 *
 * WHY THIS EXISTS: Telar's own engine runs with NODE_ENV=production, and an
 * agent session it spawns inherits that. A bare `bun test` in such a shell makes
 * React resolve its production builds, and `react/jsx-dev-runtime` then comes
 * from cjs/react-jsx-dev-runtime.production.js — which exports
 * `jsxDEV = void 0` on purpose — while bun's test transpiler still emits
 * jsxDEV() calls. Every .tsx render test then dies inside renderToString with
 * "TypeError: jsxDEV_… is not a function", which is #293. CI never saw it: there
 * NODE_ENV is unset, and `bun run test:web` sets NODE_ENV=test itself.
 *
 * ONLY "production" IS REWRITTEN. An unset NODE_ENV is bun's own business (it
 * uses "test"), and any other value was asked for deliberately.
 */
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";
