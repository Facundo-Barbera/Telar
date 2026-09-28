"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DownloadIcon, MonitorSmartphoneIcon, PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { useFollowHost } from "../host-follow";
import { isHostWindow } from "@/lib/host-window";
import {
  captureLook,
  lookFilename,
  newLookId,
  parseLookFile,
  sameComposition,
  serializeLook,
  upsertLook,
  useLooks,
  writeLooks,
  LOOKS_FULL_MESSAGE,
  LOOKS_QUOTA_MESSAGE,
  type Look,
} from "../looks";
import { BUILT_IN_LOOKS, BUILT_IN_NOTES } from "../built-in-looks";
import { useAppearance } from "../appearance";
import { useComposition } from "../composition";
import { MONO_LABEL, SANS_LABEL } from "./studio/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { LookThumb } from "./look-thumb";
import { Row, SettingsGroup } from "@/components/settings/settings-shell";

function stackPhrase(layers: readonly { type: string }[]): string {
  if (layers.length === 0) return "flat";
  const images = layers.filter((layer) => layer.type === "image").length;
  const gradients = layers.length - images;
  const parts: string[] = [];
  if (gradients > 0) parts.push(`${gradients} gradient${gradients === 1 ? "" : "s"}`);
  if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  return parts.join(" + ");
}

function compositionPhrase(look: Look): string {
  const light = stackPhrase(look.composition.light.layers);
  const dark = stackPhrase(look.composition.dark.layers);
  return light === dark ? light : `${light} / ${dark}`;
}

function lookSummary(look: Look): string {
  const sans = look.fontSans === "custom" ? look.fontSansCustom || "a custom face" : SANS_LABEL[look.fontSans];
  const mono = look.fontMono === "custom" ? look.fontMonoCustom || "a custom face" : MONO_LABEL[look.fontMono];
  const what = BUILT_IN_NOTES[look.id] ?? compositionPhrase(look);
  return `${what} · ${look.accent} · ${sans} / ${mono}`;
}

function downloadFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function LookStrip({ look }: { look: Look }) {
  return (
    <div className="w-14 shrink-0">
      <LookThumb look={look} />
    </div>
  );
}

function LookRow({
  look,
  summary,
  worn,
  lastSaved,
  onWear,
  onRename,
  onExport,
  onRemove,
}: {
  look: Look;
  summary: string;
  worn: boolean;
  lastSaved?: boolean;
  onWear: () => void;
  onRename?: (label: string) => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(look.label);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed.length > 0 && trimmed !== look.label) onRename?.(trimmed);
  };

  return (
    <tr className={cn("group border-b align-middle last:border-0", lastSaved ? "border-border/70" : "border-border/40")}>
      <td className="py-1.5 pr-3 pl-4">
        <span className="flex items-center gap-2.5">
          <span className="w-14 shrink-0">
            <LookThumb look={look} />
          </span>
          {renaming ? (
            <Input
              autoFocus
              value={draftName}
              aria-label={`Rename ${look.label}`}
              className="h-6 min-w-0 flex-1 px-1.5 text-xs"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                }
                if (event.key === "Escape") {
                  setRenaming(false);
                  setDraftName(look.label);
                }
              }}
            />
          ) : (
            <button
              type="button"
              disabled={worn}
              {...(worn ? {} : { title: `Wear ${look.label}` })}
              onClick={onWear}
              className="min-w-0 truncate text-left font-medium decoration-dotted underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
            >
              {look.label}
            </button>
          )}
          {worn && (
            <span className="shrink-0 font-mono text-4xs tracking-[0.08em] text-primary uppercase" title="The window has this look on">
              Worn
            </span>
          )}
        </span>
      </td>
      <td className="py-1.5 pr-3 text-muted-foreground">
        <span className="block truncate">{summary}</span>
      </td>
      <td className="py-1.5 pr-4">
        <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button size="sm" variant="ghost" disabled={worn} title={`Wear ${look.label}`} onClick={onWear}>
            Wear
          </Button>
          {onRename && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Rename"
              aria-label={`Rename ${look.label}`}
              onClick={() => {
                setDraftName(look.label);
                setRenaming(true);
              }}
            >
              <PencilIcon />
            </Button>
          )}
          {onExport && (
            <Button size="icon-sm" variant="ghost" title="Export" aria-label={`Export ${look.label}`} onClick={onExport}>
              <DownloadIcon />
            </Button>
          )}
          {onRemove && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Take this look off the shelf. The window keeps what it has on."
              aria-label={`Delete ${look.label}`}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

const api = createEngineApi();

type HostLookState = { status: "loading" } | { status: "ready"; look: Look } | { status: "empty" | "failed" | "invalid" };

const HOST_LOOK_HINT: Record<"loading" | "empty" | "failed" | "invalid", string> = {
  loading: "Asking the engine…",
  empty: "Nothing published yet — the host publishes on its own.",
  failed: "The engine did not answer.",
  invalid: "The host published something this build cannot read.",
};

function HostLookRow({ onWear }: { onWear: (look: Look) => void }) {
  const { mode, detach, follow } = useFollowHost();
  const following = mode === "follow";
  const [state, setState] = useState<HostLookState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void api
      .appearance()
      .then((answer) => {
        if (!live) return;
        if (answer.appearance) setState({ status: "ready", look: answer.appearance.look });
        else setState({ status: answer.updatedAt === null ? "empty" : "invalid" });
      })
      .catch(() => {
        if (live) setState({ status: "failed" });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  const ready = state.status === "ready";
  return (
    <Row
      id="settings-row-appearance-host-look"
      label={
        <span className="flex items-center gap-2">
          {ready ? (
            <LookStrip look={state.look} />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground [&_svg]:size-4">
              <MonitorSmartphoneIcon />
            </span>
          )}
          <span>{following ? "Following the host's look" : "Host's look"}</span>
        </span>
      }
      hint={
        ready
          ? `“${state.look.label}” — ${compositionPhrase(state.look)}${following ? " · changing anything here stops following" : ""}`
          : HOST_LOOK_HINT[state.status]
      }
      control={
        <div className="flex items-center gap-2">
          {ready && !following && (
            <Button size="sm" variant="outline" onClick={() => onWear(state.look)}>
              Wear
            </Button>
          )}
          {!ready && (
            <Button size="sm" variant="ghost" disabled={state.status === "loading"} onClick={retry}>
              {state.status === "loading" ? "Loading…" : "Retry"}
            </Button>
          )}
          <Switch
            checked={following}
            disabled={!ready && !following}
            onCheckedChange={(next) => (next ? follow() : detach())}
            aria-label="Follow the host's look"
            title={
              ready
                ? following
                  ? "Stop following the host's look"
                  : "Wear the host's look, and keep wearing it as it changes"
                : "The host has not published a look to follow."
            }
          />
        </div>
      }
    />
  );
}

const subscribeToNothing = () => () => {};
const hostNow = () => isHostWindow();
const hostOnTheServer = () => true;

export function LooksSection({ onWear }: { onWear: (look: Look) => void }) {
  const isHost = useSyncExternalStore(subscribeToNothing, hostNow, hostOnTheServer);
  const { appearance } = useAppearance();
  const { composition } = useComposition();
  const worn = useCallback(
    (look: Look) => look.accent === appearance.accent && sameComposition(look.composition, composition),
    [appearance.accent, composition],
  );
  const looks = useLooks();
  const [error, setError] = useState<string | false>(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const commit = (next: Look[]): boolean => {
    if (!writeLooks(next)) {
      setError(LOOKS_QUOTA_MESSAGE);
      return false;
    }
    setError(false);
    return true;
  };

  const importFile = (raw: string) => {
    const look = parseLookFile(raw, newLookId());
    if (!look) {
      setError("That file is not a Telar look.");
      return;
    }
    const next = upsertLook(looks, look);
    if (!next) {
      setError(LOOKS_FULL_MESSAGE);
      return;
    }
    if (commit(next)) onWear(look);
  };

  const saveLook = () => {
    const from = BUILT_IN_LOOKS.find((entry) => worn(entry))?.label;
    const next = upsertLook(looks, captureLook(from ? `${from} — edited` : "My look"));
    if (!next) {
      setError(LOOKS_FULL_MESSAGE);
      return;
    }
    commit(next);
  };

  return (
    <SettingsGroup
      title="Looks"
      description="A look is a whole composition — both colour states, their layers and their colours — with the accent, the type and the depth saved around it. Wear one to put the lot on, then change anything below."
      action={
        <div className="flex items-center gap-2">
          <span className="font-mono text-3xs tracking-[0.08em] text-muted-foreground/60 uppercase tabular-nums">
            {looks.length + BUILT_IN_LOOKS.length}
          </span>
          <Button size="sm" variant="outline" title="Keep what the window is wearing as a card" onClick={saveLook}>
            Save look
          </Button>
          <Button size="icon-sm" variant="ghost" title="Import a look file" aria-label="Import a look" onClick={() => fileInput.current?.click()}>
            <UploadIcon />
          </Button>
        </div>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void file.text().then(importFile);
        }}
      />
      {error && <p className="py-1.5 text-xs text-warning">{error}</p>}
      {!isHost && <HostLookRow onWear={onWear} />}
      <div className="-mx-4">
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-border/40 text-2xs font-normal tracking-wide text-muted-foreground uppercase">
              <th scope="col" className="w-[40%] py-1.5 pr-3 pl-4 font-normal">
                Look
              </th>
              <th scope="col" className="py-1.5 pr-3 font-normal">
                Carries
              </th>
              <th scope="col" className="w-[156px] py-1.5 pr-4 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {looks.map((look, index) => (
              <LookRow
                key={look.id}
                look={look}
                summary={lookSummary(look)}
                worn={worn(look)}
                lastSaved={index === looks.length - 1}
                onWear={() => onWear(look)}
                onRename={(label) => {
                  const next = upsertLook(looks, { ...look, label });
                  if (next) commit(next);
                }}
                onExport={() => downloadFile(lookFilename(look), serializeLook(look))}
                onRemove={() => commit(looks.filter((entry) => entry.id !== look.id))}
              />
            ))}
            {BUILT_IN_LOOKS.map((look) => (
              <LookRow key={look.id} look={look} summary={lookSummary(look)} worn={worn(look)} onWear={() => onWear(look)} />
            ))}
          </tbody>
        </table>
      </div>
    </SettingsGroup>
  );
}
