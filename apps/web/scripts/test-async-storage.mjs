/**
 * A REAL `AsyncLocalStorage` ON THE GLOBAL, BEFORE ANY TEST FILE LOADS.
 *
 * THE PROBLEM, and it is the same shape as test-dom.mjs's: a decision made
 * ONCE, at import, by whichever file happens to get there first.
 * `next/dist/server/app-render/async-local-storage` reads
 * `globalThis.AsyncLocalStorage` at module scope and, when it is missing,
 * substitutes a `FakeAsyncLocalStorage` whose every method throws
 * "Invariant: AsyncLocalStorage accessed in runtime where it is not
 * available". Node defines that global in the runtimes Next ships for; bun does
 * not, and the suite shares one process.
 *
 * SO THE SYMPTOM IS ACTION AT A DISTANCE. A file that renders a Next-aware
 * component to markup passes on its own and fails in company, depending on
 * whether some earlier file had already pulled `next/server/after` into the
 * process. Adding a test file elsewhere in the suite is enough to flip it —
 * which is exactly how this was found (#389).
 *
 * `??=`, not `=`: a runtime that already provides one keeps it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
