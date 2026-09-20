# Keeping Spotlight and Time Machine out of the session checkouts — #634

Telar creates and destroys thousands of files per worktree, many times a day,
under the worktrees root (`<TELAR_HOME>/engine/worktrees` by default, or
wherever Settings ▸ Storage has put it). Spotlight indexes the contents and Time
Machine tracks every creation and deletion.

**#634 asked for either a real exclusion or documentation of how to apply one.
This is the documentation, and the answer is deliberate rather than a
preference: Telar does not apply either exclusion itself.** The two mechanisms
the issue named have different problems and the reasons do not overlap.

## Spotlight — the mechanism the issue named does not work here

`.metadata_never_index` turns off indexing **for a whole volume, placed at that
volume's root**. Telar's worktrees root is never a volume root: the default is
`<engineRoot>/worktrees`, and a chosen root is a directory on a drive, not the
drive. Inside an ordinary folder the file is ignored on current macOS.

Verified on macOS 26.6.2 (build 25G83), twice, before anything was built on it:

- A fixture directory with `.metadata_never_index` written **before any content
  existed**. Both a top-level file and one nested two levels down were returned
  by `mdfind -onlyin <fixture>` within six seconds.
- A control directory without the marker, indexed identically — so the probe was
  measuring the marker rather than measuring whether indexing worked at all.

Writing that file into the worktrees root would therefore ship a marker that
looks like a fix, reads like a fix in a diff, and does nothing. That is worse
than not shipping it, because the next person to ask "are the checkouts indexed?"
would find the file and stop looking.

**Re-check this before trusting it.** It is a macOS behaviour, not a Telar one,
and it has changed at least once. The probe is three commands:

```sh
mkdir -p /tmp/idx-probe && : > /tmp/idx-probe/.metadata_never_index
echo uniquetokenhere > /tmp/idx-probe/file.txt
sleep 10 && mdfind -onlyin /tmp/idx-probe uniquetokenhere   # a hit means it is still ignored
```

### What does work, and why Telar still does not do it

Spotlight honours a **`.noindex` suffix** on the folder name, and ignores
dot-prefixed folders. Either would work — by renaming the root.

Telar will not rename it. The default root would move for every existing
install, orphaning checkouts that are still in use (they keep working, because a
worktree is addressed by the absolute path recorded on its session, never by
recomputing one from the root — see `worktrees-location.ts`), and a **chosen**
root is a path the person typed. Renaming somebody's directory to change an
indexing preference is not a thing an app should do quietly.

**To exclude it yourself**, use System Settings ▸ Spotlight ▸ Search Privacy and
add the worktrees root. That is a user action by construction, it survives
Telar moving the root only if you move the entry too, and it is reversible in
the same pane.

## Time Machine — it works, and it is not Telar's call

`tmutil addexclusion` does what the issue says. Two facts decide against Telar
running it for you:

1. **A worktree holds uncommitted work.** The repo says so itself, in
   `worktrees-move.ts`: "A half-migrated worktrees root loses uncommitted work
   in every open session." Excluding the checkouts from Time Machine means that
   work has no backup. A person may well want that trade; they should make it.
2. **The default exclusion is sticky, and copies inherit it.** From `man tmutil`:
   a location-independent exclusion "follows a file or directory… when the item
   is copied, the copy retains the exclusion." So a decision Telar made about its
   own directory would propagate into copies of a person's work made anywhere
   else on the machine, long after they had stopped thinking about Telar.

An app that quietly removes a directory from its owner's backups, in a way that
travels with copies of their files, is doing something they did not ask for.

**To exclude it yourself**, against your own worktrees root — the path in
Settings ▸ Storage, not necessarily the default:

```sh
ROOT="$HOME/Library/Application Support/Telar/engine/worktrees"
sudo tmutil addexclusion -p "$ROOT"   # fixed-path; see the trade-off below
tmutil isexcluded "$ROOT"             # read-only check, no privileges needed
```

**Pick the kind deliberately — they behave differently and neither is strictly
better** (all three are described in `man tmutil`):

- **`-p`, fixed-path.** Applies to whatever is at that path, and is *not*
  inherited when files are copied. Requires **root and Full Disk Access**, so
  `sudo` alone is not enough if your terminal has not been granted Full Disk
  Access in System Settings ▸ Privacy & Security. The man page warns that
  fixed-path exclusions "are not automatically cleaned up when items are moved
  or deleted and will take effect again once an item exists at an excluded
  path" — which for this directory is the point, since Telar creates and
  destroys checkouts under it continuously.
- **No flag, sticky (the default).** Needs no privileges, but follows the item
  and **is retained when the item is copied**. Avoid it here: copies of your
  work made elsewhere would silently inherit the exclusion.

Undo with `sudo tmutil removeexclusion -p "$ROOT"` — same flag, same privileges.

## The measurement this is still waiting on

The issue's 80% `fseventsd` figure is from another machine and another workload,
and **has not been reproduced here**. Nothing above depends on it: the Spotlight
finding is about a mechanism not working, and the Time Machine finding is about
whose decision it is. But the question "is this worth doing at all" is still
open, and #634 named what would settle it — `fseventsd` and `mds` CPU over a
normal day, with and without the exclusions, on one machine.

If the win turns out to be real it is a property of **every** checkout-heavy
directory, not of Telar's store — which is the issue's own third reason for
filing this separately, and the reason this page is written for a person to
apply to `~/Projects` as readily as to the worktrees root.
