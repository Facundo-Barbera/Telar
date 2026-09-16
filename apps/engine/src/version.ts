/**
 * THE ENGINE'S OWN VERSION, as a string this code can spend.
 *
 * It exists because Telar now talks to a model API directly (#526) and OpenCode
 * Go asks a third-party agent to identify itself: `User-Agent: telar/<version>`.
 * That is an outward-facing claim about which build is calling, so it must be
 * the build's real number rather than a placeholder.
 *
 * A CONSTANT RATHER THAN A `package.json` IMPORT, for the reason
 * `opencode/version.ts` is one: this package compiles with `include: ["src"]`
 * and ships through a packager that rewrites layout, so reaching outside the
 * source tree for a number is a build-shaped dependency for a string. The drift
 * that buys is caught by `test/version.test.ts`, which asserts the two agree —
 * so bumping the package without bumping this fails the suite rather than
 * quietly telling a provider the wrong thing.
 */
export const TELAR_ENGINE_VERSION = "0.1.0";
