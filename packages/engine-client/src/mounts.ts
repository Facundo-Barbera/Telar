/**
 * WHERE AN EXTERNAL DISK APPEARS ON THIS PLATFORM — the one list, issue #665.
 *
 * ══ IT WAS FIVE LISTS, AND EACH ONE SAID SO ══
 *
 * `volumes.ts`, `worktree.ts`, `fs-dirs.ts`, `volume-watch.js` and `main.js`
 * each carried their own copy, and each carried a comment explaining that it
 * was a copy — one of them called itself "the fourth copy of this list". The
 * duplication was deliberate and the reason given was true: they are separate
 * apps and none imports another.
 *
 * What the reason did not survive is #665. On win32 every one of them returns
 * an empty list, and every caller reads that absence as a POSITIVE answer —
 * "this path is on the machine's own disk". Fixing that meant editing five
 * files that agree by convention, which is a fix that holds exactly until the
 * sixth copy appears. So the list moves here, where the engine and the cockpit
 * can both import it.
 *
 * ══ WHY IT IS IN THE PROTOCOL PACKAGE AND NOT IN THE ENGINE ══
 *
 * `apps/web` depends on `@telar/engine-client` and not on `apps/engine`, and
 * `apps/engine` depends on it too. This is the only module both can reach. It
 * is in the ROOT entry rather than `./node` because it touches no filesystem
 * and imports nothing — a browser chunk that pulled it in would get four
 * strings, not `node:fs`.
 *
 * ══ AND TWO COPIES REMAIN, WHICH IS A CONSTRAINT RATHER THAN A COMPROMISE ══
 *
 * `apps/desktop` is plain CommonJS packaged by electron-builder from an
 * explicit file allowlist inside its own directory, with no workspace
 * dependency on this package and no build step that could inline one. Adding
 * `@telar/engine-client` as a dependency of the shell to share four strings
 * would pull zod and the whole protocol into the app bundle.
 *
 * So `volume-watch.js` and `main.js` keep their own copies, and
 * `apps/desktop/mount-roots.test.js` holds them to THIS function, platform by
 * platform — a test rather than a convention, which is the part that was
 * missing. A sixth copy that disagrees is a red test rather than a bug nobody
 * notices until a person's drive is out.
 */

/**
 * The directories a removable volume is mounted under, for `platform`.
 *
 * A SHORT LIST RATHER THAN A DEVICE-NUMBER WALK, and the reason is worth
 * keeping where the list is. The obvious test — "this path's device differs
 * from `/`'s" — is wrong on every modern Mac: APFS puts `/Users` on a Data
 * volume firmlinked under a read-only System volume, so `~/code/anything` sits
 * on a different `st_dev` than `/` and every ordinary project would be declared
 * external.
 *
 * (That rejection is about comparing against the BOOT device. Comparing two
 * arbitrary paths against each other is a different question with a different
 * answer — see `package-caches.ts`, which does exactly that and says why.)
 *
 * EMPTY IS NOT "NO VOLUMES HERE", it is "this platform cannot be asked" — see
 * `volumeSupportOn`, which is the reading every caller actually needs.
 */
export function mountRootsFor(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/mnt"] : [];
}

/**
 * CAN THIS PLATFORM BE ASKED WHICH REMOVABLE VOLUME A PATH IS ON — issue #665,
 * and the answer is three-valued because the honest answer is.
 *
 * ══ THE SILENT `[]` IS THE BUG ══
 *
 * `mountRootsFor("win32")` is empty, so no path is ever under a mount root, so
 * every "which volume is this on" answers `undefined` — which callers read as
 * *"this path is on the machine's own disk"*. On Windows that is not a cautious
 * answer, it is a wrong one, and its two consequences point in opposite
 * directions:
 *
 *   - A store on `D:\` records no volume, so unplugging the drive skips the
 *     designed-for `waiting` state — no window naming the drive, no
 *     `volume-watch` recovery, no "nothing has been touched" — and lands on a
 *     flat refuse that invites somebody to start over on top of their history.
 *   - A checkouts root on `D:\` reports as *configured and fine* even while the
 *     drive is out, so the blocker never fires, the cut proceeds, and
 *     `mkdirSync` fails mid-session with an I/O error instead of the sentence
 *     the design wrote for exactly this.
 *
 * ══ WHY LINUX IS ITS OWN ANSWER ══
 *
 * `/media` and `/mnt` are recognised, so a volume ON a Linux box is found. But
 * reading a drive's own uuid is darwin-only, so there is no identity to match a
 * remount against: a drive that comes back under a different name cannot be
 * resolved as a rename and stays absent until somebody re-chooses the location
 * by hand. That is half the feature, and folding it in with either neighbour
 * would state something false about one of them.
 */
export type VolumeSupport = "identified" | "located" | "unsupported";
export function volumeSupportOn(platform: NodeJS.Platform): VolumeSupport {
  if (mountRootsFor(platform).length === 0) return "unsupported";
  return platform === "darwin" ? "identified" : "located";
}
