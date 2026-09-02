"use client";

import { useState } from "react";
import { FolderIcon } from "lucide-react";
import { projectHue, projectIconUrl, projectInitial } from "@/lib/project-avatar";
import { cn } from "@/lib/utils";

/**
 * A project's mark, in three honesties: the icon its checkout actually
 * carries, else a tinted initial from its name, else the plain folder that
 * says "a directory, and nothing more is known".
 *
 * The `<img>` FAILS FORWARD: the engine's icon key is derived on list and the
 * file can vanish between the list and the fetch, so a broken image flips to
 * the initial instead of a missing-image glyph.
 */
export function ProjectAvatar({
  name,
  projectId,
  icon,
  size = 12,
  className,
}: {
  name?: string;
  projectId?: string;
  /** `Project.icon` — the content-derived key. Absent means no file was found. */
  icon?: string;
  /** Rendered box in px. The type stays square at any size. */
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };

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
