"use client";

import { useState } from "react";
import { BellIcon, CameraIcon, ClipboardIcon, GlobeIcon, LockIcon, MapPinIcon, MicIcon, ScreenShareIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  describePermissionKinds,
  describeSitePermission,
  describeSiteStanding,
  permissionPromptTitle,
  siteLabel,
  PERMISSION_KIND_TITLES,
  type PermissionPrompt,
  type PermissionPromptSource,
  type SitePermissionKind,
  type SitePermissionRecord,
} from "../desktop-site-permissions";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<SitePermissionKind, LucideIcon> = {
  camera: CameraIcon,
  microphone: MicIcon,
  notifications: BellIcon,
  geolocation: MapPinIcon,
  "clipboard-read": ClipboardIcon,
  "display-capture": ScreenShareIcon,
};

export function PermissionKindIcon({ kind, className }: { kind: SitePermissionKind; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? GlobeIcon;
  return <Icon aria-hidden className={cn("size-3.5", className)} />;
}

export function SiteSecurityIcon({ origin, className }: { origin: string | undefined; className?: string }) {
  const secure = Boolean(origin && origin.startsWith("https://"));
  const Icon = secure ? LockIcon : GlobeIcon;
  return <Icon aria-hidden className={cn("size-3.5", className)} />;
}

const VARIANTS = ["default", "outline", "ghost"] as const;

/** A prompt's three answers, strongest first. */
function Answers({ busy, answers }: { busy?: boolean | undefined; answers: [label: string, onClick: () => void, disabled?: boolean][] }) {
  return (
    <div className="flex items-center gap-1.5">
      {answers.map(([label, onClick, disabled], at) => (
        <Button key={label} size="sm" variant={VARIANTS[at]} disabled={busy || disabled} onClick={onClick}>
          {label}
        </Button>
      ))}
    </div>
  );
}

export type PermissionAnswer = { decision: "allow" | "once" | "block"; sourceId?: string };

export function SitePermissionPrompt({
  prompt,
  onAnswer,
  busy,
}: {
  prompt: PermissionPrompt;
  onAnswer: (answer: PermissionAnswer) => void;
  busy?: boolean;
}) {
  if (prompt.sources) return <ScreenSharePicker prompt={prompt} sources={prompt.sources} onAnswer={onAnswer} busy={busy} />;
  return (
    <div className="flex flex-col gap-2.5" role="group" aria-label="Site permission request">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex shrink-0 items-center gap-1 text-muted-foreground">
          {prompt.kinds.map((kind) => (
            <PermissionKindIcon key={kind} kind={kind} />
          ))}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{permissionPromptTitle(prompt)}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Remembered for this browser profile. “Allow once” is not.
          </p>
        </div>
      </div>
      <Answers busy={busy} answers={[["Allow", () => onAnswer({ decision: "allow" })], ["Allow once", () => onAnswer({ decision: "once" })], ["Block", () => onAnswer({ decision: "block" })]]} />
    </div>
  );
}

function ScreenSharePicker({
  prompt,
  sources,
  onAnswer,
  busy,
}: {
  prompt: PermissionPrompt;
  sources: PermissionPromptSource[];
  onAnswer: (answer: PermissionAnswer) => void;
  busy?: boolean;
}) {
  const ordered = [...sources].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "screen" ? -1 : 1));
  const [chosen, setChosen] = useState<string>();
  return (
    <div className="flex flex-col gap-2.5" role="group" aria-label="Choose what to share">
      <div className="flex items-start gap-2">
        <ScreenShareIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs font-medium text-foreground">{permissionPromptTitle(prompt)}</p>
      </div>
      <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto">
        {ordered.map((source) => (
          <button
            key={source.id}
            type="button"
            aria-pressed={chosen === source.id}
            onClick={() => setChosen(source.id)}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-1 text-left",
              chosen === source.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/60",
            )}
          >
            {source.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL the shell rendered; nothing for next/image here
              <img src={source.thumbnail} alt="" aria-hidden className="aspect-video w-full rounded-[3px] object-cover" />
            ) : (
              <span aria-hidden className="flex aspect-video w-full items-center justify-center rounded-[3px] bg-muted">
                <ScreenShareIcon className="size-4 text-muted-foreground" />
              </span>
            )}
            <span className="truncate text-3xs text-muted-foreground">{source.name}</span>
          </button>
        ))}
      </div>
      <Answers
        busy={busy}
        answers={[["Share", () => chosen && onAnswer({ decision: "allow", sourceId: chosen }), !chosen], ["Cancel", () => onAnswer({ decision: "allow" })], ["Never allow", () => onAnswer({ decision: "block" })]]}
      />
    </div>
  );
}

export function SitePermissionsPopover({
  origin,
  records,
  onForget,
  onReset,
  busy,
}: {
  origin: string | undefined;
  records: SitePermissionRecord[];
  onForget: (kind: SitePermissionKind) => void;
  onReset: () => void;
  busy?: boolean;
}) {
  if (!origin) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-foreground">No site open</p>
        <p className="text-2xs text-muted-foreground">Permissions belong to a page’s address; a blank tab has none.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-label="Site permissions">
      <div className="flex items-start gap-2">
        <SiteSecurityIcon origin={origin} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-2xs text-foreground">{siteLabel(origin)}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">{describeSiteStanding(origin, records)}</p>
        </div>
      </div>
      {records.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {records.map((record) => (
            <li key={record.kind} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/60">
              <PermissionKindIcon kind={record.kind} className={record.decision === "allow" ? "text-foreground" : "text-muted-foreground"} />
              <span className="min-w-0 flex-1 truncate text-2xs">{describeSitePermission(record)}</span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Forget ${PERMISSION_KIND_TITLES[record.kind]} for ${siteLabel(origin)}`}
                title="Forget this answer. The site asks again next time."
                className="shrink-0 rounded px-1 py-0.5 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                onClick={() => onForget(record.kind)}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      {records.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          className="self-start text-destructive hover:text-destructive"
          title={`Forget every answer given to ${siteLabel(origin)} in this profile. It asks again next time.`}
          onClick={onReset}
        >
          Reset permissions
        </Button>
      )}
    </div>
  );
}

export function describePermissionDenial(denial: { origin: string; kinds: SitePermissionKind[]; reason: string }): string {
  return `${siteLabel(denial.origin)} could not use your ${describePermissionKinds(denial.kinds)}. ${denial.reason}`;
}
