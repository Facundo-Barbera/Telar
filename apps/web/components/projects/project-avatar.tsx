"use client";

import { useState } from "react";
import { FolderIcon } from "lucide-react";
import { projectHue, projectIconUrl, projectInitial } from "@/lib/project-avatar";
import { projectGlyph } from "@/lib/project-icons";
import { cn } from "@/lib/utils";

/**
 * A project's mark, in four honesties: the one a person CHOSE, else the icon its
 * checkout actually carries, else a tinted initial from its name, else the plain
 * folder that says "a directory, and nothing more is known".
 *
 * THE CHOSEN MARK IS FIRST, and that ordering is the whole point of being able
 * to choose one: a project whose checkout carries a favicon nobody likes has no
 * other way to say so. The chosen mark and the discovered one are separate
 * fields on the record rather than one (`Project.iconName` explains why), so
 * preferring one here costs no branch anywhere else.
 *
 * A NAME THIS BUILD DOES NOT KNOW IS NOT A MARK. `projectGlyph` answers
 * `undefined` for an id from a newer cockpit's set, and this falls straight
 * through to the checkout's own icon rather than drawing a hole where a glyph
 * should be.
 *
 * The `<img>` FAILS FORWARD: the engine's icon key is derived on list and the
 * file can vanish between the list and the fetch, so a broken image flips to
 * the initial instead of a missing-image glyph.
 */
export function ProjectAvatar({
  name,
  projectId,
  icon,
  iconName,
  iconEmoji,
  size = 12,
  className,
}: {
  name?: string;
  projectId?: string;
  /** `Project.icon` — the content-derived key. Absent means no file was found. */
  icon?: string;
  /** `Project.iconName` — the glyph a person picked. Outranks `icon`. */
  iconName?: string;
  /** `Project.iconEmoji` — a mark typed before the picker existed. Outranks `icon`. */
  iconEmoji?: string;
  /** Rendered box in px. The type stays square at any size. */
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };

  const picked = projectGlyph(iconName);
  if (picked) {
    // `currentColor` on purpose: a chosen glyph takes the ink of whatever list
    // it is in — rail, picker, header — so it reads as part of the row rather
    // than as a sticker on it.
    return <picked.Glyph aria-hidden style={box} className={cn("shrink-0", className)} />;
  }
  if (iconEmoji) {
    return (
      <span
        aria-hidden
        // Sized off the box like the initial below, so a mark and a letter sit
        // at the same weight wherever the two appear in one list.
        style={{ ...box, fontSize: Math.round(size * 0.72) }}
        className={cn("flex shrink-0 items-center justify-center leading-none", className)}
      >
        {iconEmoji}
      </span>
    );
  }
  if (icon && projectId && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- engine-served bytes with an immutable cache key; nothing for next/image to add
      <img
        src={projectIconUrl(projectId, icon)}
        alt=""
        aria-hidden
        style={box}
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-[25%] object-cover", className)}
      />
    );
  }
  if (name?.trim()) {
    return (
      <span
        aria-hidden
        style={{
          ...box,
          fontSize: Math.max(7, Math.round(size * 0.62)),
          // Muted, light/dark-agnostic: low saturation and mid lightness read
          // on both grounds without a theme branch.
          backgroundColor: `hsl(${projectHue(name.trim())} 45% 50% / 0.25)`,
          color: `hsl(${projectHue(name.trim())} 45% 38%)`,
        }}
        className={cn("flex shrink-0 items-center justify-center rounded-[25%] font-medium leading-none dark:brightness-150", className)}
      >
        {projectInitial(name)}
      </span>
    );
  }
  return <FolderIcon style={box} className={cn("shrink-0 text-sidebar-foreground/40", className)} />;
}
