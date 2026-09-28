"use client";

import { useState } from "react";
import { FolderIcon } from "lucide-react";
import { isTelarIcon } from "@telar/engine-client";
import { projectHue, projectIconUrl, projectInitial } from "../project-avatar";
import { IdentityIcon } from "@/ui/telar-icons";
import { cn } from "@/ui/utils";

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
  icon?: string;
  iconName?: string;
  iconEmoji?: string;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };

  if (isTelarIcon(iconName)) {
    return (
      <span aria-hidden style={box} className={cn("flex shrink-0 items-center justify-center", className)}>
        <IdentityIcon icon={iconName} className="size-full" />
      </span>
    );
  }
  if (iconEmoji) {
    return (
      <span
        aria-hidden
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
