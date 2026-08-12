"use client";

// LANE: project (NEW) — shared primitives for the project GitHub tab demo
// (project-github-tab): avatars, state chips, section bands, the ~size
// formatter. The hub shell itself now lives in github-tab.tsx (the reframed,
// constrained hub owns its own anatomy). Colors via class utilities — no `dark:`
// utilities, both themes render in-page under the StageFrame token wrapper.
import { type ReactNode } from "react";
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { avatarUrl, ghUser, initials } from "./git-fixtures";

/* --------------------------------------------------------- git primitives */

// ~ size formatter — the tilde is load-bearing (these are du estimates).
export function fmtSize(mb: number): string {
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${Math.round(mb)} MB`;
}

// A tiny state chip in the git tab's own quiet vocabulary. Reclaimable is the
// one that earns color (emerald) — it's the affordance the whole tab exists for.
export function GitChip({
  tone,
  children,
  className,
}: {
  tone: "reclaimable" | "active" | "dirty" | "merged" | "stale" | "muted";
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    reclaimable: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    active: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    dirty: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    merged: "border-border bg-muted/40 text-muted-foreground",
    stale: "border-border bg-transparent text-muted-foreground/80",
    muted: "border-border bg-transparent text-muted-foreground",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 gap-1 px-1.5 py-0 font-mono text-[10px]",
        tones[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}

/* -------------------------------------------------------------- avatars */

// Deterministic initials-circle tone, hashed off the login so a given user
// always falls back to the same color. Class utilities → both themes render.
const FALLBACK_TONES = [
  "bg-sky-500/20 text-sky-300",
  "bg-violet-500/20 text-violet-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-amber-500/20 text-amber-300",
  "bg-rose-500/20 text-rose-300",
  "bg-indigo-500/20 text-indigo-300",
  "bg-teal-500/20 text-teal-300",
];
function toneFor(login: string): string {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return FALLBACK_TONES[h % FALLBACK_TONES.length];
}

// A GitHub avatar: the real profile picture from github.com/<login>.png, with a
// deterministic initials circle when the login is unknown or the image 404s
// (base-ui swaps to Fallback on image error). `size` is px.
export function GhAvatar({
  login,
  size = 20,
  className,
}: {
  login: string;
  size?: number;
  className?: string;
}) {
  const u = ghUser(login);
  return (
    <AvatarPrimitive.Root
      style={{ width: size, height: size }}
      title={`${u.name} · @${u.login}`}
      className={cn(
        "relative inline-flex shrink-0 select-none overflow-hidden rounded-full ring-1 ring-border/70",
        className,
      )}
    >
      <AvatarPrimitive.Image
        src={avatarUrl(login)}
        alt=""
        className="size-full rounded-full object-cover"
      />
      <AvatarPrimitive.Fallback
        style={{ fontSize: Math.max(8, Math.round(size * 0.4)) }}
        className={cn(
          "flex size-full items-center justify-center rounded-full font-semibold leading-none",
          toneFor(login),
        )}
      >
        {initials(u.name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

// Overlapping avatar stack (reviewers, assignees) with a +N overflow chip.
export function AvatarStack({
  logins,
  size = 18,
  max = 4,
}: {
  logins: string[];
  size?: number;
  max?: number;
}) {
  if (logins.length === 0) return null;
  const shown = logins.slice(0, max);
  const extra = logins.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((l) => (
        <GhAvatar key={l} login={l} size={size} className="ring-2 ring-background" />
      ))}
      {extra > 0 && (
        <span
          style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
          className="z-10 flex items-center justify-center rounded-full bg-muted font-mono font-medium text-muted-foreground ring-2 ring-background"
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

// The section band used to head Worktrees / Branches / Activity / Issues / PRs.
export function SectionBand({
  icon: Icon,
  label,
  count,
  right,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
        {label}
      </span>
      {count != null && (
        <Badge
          variant="outline"
          className="px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
        >
          {count}
        </Badge>
      )}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}
