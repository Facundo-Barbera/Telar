/**
 * ONE AUTHOR'S FACE — issue #790, §1a of the design on #49.
 *
 * WHY AN AVATAR EARNS ITS PIXELS HERE AND USUALLY WOULD NOT. On a repository with
 * twelve contributors a face is decoration: the login beside it already says who,
 * in fewer pixels and in the words you would use out loud, and the list row's own
 * comment said exactly that about an assignee stack. This repository is the other
 * case. Nearly every comment on it is an agent posting under one account, so a
 * thread is a column of identical names — and the thing a reader is actually
 * scanning for is the boundary between one voice and the next. A face is the only
 * mark in the author bar that a person recognises without reading.
 *
 * NO STATE, AND THAT IS DELIBERATE. The monogram is drawn UNDERNEATH and the image
 * sits over it, so an avatar that 404s — a bot, a deleted account, a machine that
 * cannot reach GitHub's CDN — reveals the letter rather than needing a failed-load
 * flag and a re-render. `onError` hides the `<img>` outright as well, because a
 * browser that draws a broken-image glyph for `alt=""` would otherwise draw it over
 * the letter; between the two the fallback holds without this component ever being
 * anything but a pure function of its props. That is also what lets
 * `renderToStaticMarkup` assert on it.
 *
 * THE BOX IS THE CALLER'S. Every glyph in these two surfaces is sized at its use
 * site (`size-3`, `size-3.5`) and an avatar is one more glyph; what is NOT the
 * caller's is which pixel size to ask GitHub for — see `AVATAR_PIXELS` for why one
 * shared number is what makes a forty-comment thread a single fetch.
 */

import { avatarSrc, authorMonogram } from "@/lib/github-forge";
import { cn } from "@/lib/utils";

export function GitHubAvatar({
  login,
  src,
  className,
}: {
  /** The login, for the monogram and for the alt text. */
  login?: string;
  /** `authorAvatar` off the engine's record. Absent draws the monogram alone. */
  src?: string;
  /** The box, e.g. `size-3.5`. Round and centred whatever the caller passes. */
  className?: string;
}) {
  return (
    <span
      aria-hidden
      /* `bg-muted` and a border so the monogram reads as a placeholder rather
         than as a letter someone typed, and so a transparent PNG still has an
         edge on a translucent Look (#691). */
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-[0.55em] leading-none font-medium text-muted-foreground select-none",
        className,
      )}
      title={login ?? "unknown author"}
    >
      {authorMonogram(login)}
      {src && (
        /* eslint-disable-next-line @next/next/no-img-element -- GitHub's avatar
           CDN, reached through the github.com/<login>.png redirect; next/image
           cannot optimise what it is not configured for and configuring it would
           mean allow-listing GitHub's CDNs for one 48px circle. */
        <img
          src={avatarSrc(src)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
