"use client";

import { DownloadIcon } from "lucide-react";
import type { ProviderInstance, ProviderProbe } from "@telar/engine-client";
import { normaliseContextNoticePercent } from "@/features/composer";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { CopyCommand } from "@/ui/copy-command";
import { DRIVER_LABEL, displayNameOf, isDefaultInstance, updateAdvisory } from "../provider-instances";
import { AccentPicker, BlurInput, CompactionField, EnvEditor } from "./provider-instance-fields";
import type { InstancePatch } from "./provider-instance-card";

type Advisory = NonNullable<ReturnType<typeof updateAdvisory>>;

function UpdateAdvisory({
  advisory,
  driver,
  onUpdateCli,
  updating,
}: {
  advisory: Advisory;
  driver: ProviderInstance["driver"];
  onUpdateCli?: (() => void) | undefined;
  updating?: boolean | undefined;
}) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{advisory.headline}</span>
        {advisory.command && onUpdateCli && (
          <Button size="sm" className="h-7 px-2 text-xs" disabled={updating} onClick={onUpdateCli}>
            {updating ? <Spinner /> : <DownloadIcon className="size-3.5" />}
            {updating ? "Updating" : "Update now"}
          </Button>
        )}
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">{advisory.detail}</p>
      {advisory.command && (
        <>
          <CopyCommand command={advisory.command} />
          <p className="text-2xs leading-snug text-muted-foreground/70">
            Telar picked this from how the CLI was installed, and runs exactly it. Any other login of {DRIVER_LABEL[driver]} pointing at the same binary
            moves with it.
          </p>
        </>
      )}
    </div>
  );
}

function ContextNoticeField({ instance, onPatch }: { instance: ProviderInstance; onPatch: (patch: InstancePatch) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-foreground">Heavy context notice</span>
      <span className="mt-1.5 flex items-center gap-1.5">
        <BlurInput
          key={normaliseContextNoticePercent(instance.contextNoticePercent)}
          value={String(normaliseContextNoticePercent(instance.contextNoticePercent))}
          onCommit={(next) => {
            const typed = next.trim();
            if (!typed) {
              onPatch({ contextNoticePercent: null });
              return;
            }
            const wanted = Number(typed);
            if (Number.isFinite(wanted)) onPatch({ contextNoticePercent: wanted });
          }}
          type="number"
          min={1}
          max={100}
          step={1}
          aria-label="Heavy context notice"
          className="h-8 w-20 text-right font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="text-2xs text-muted-foreground">% of the model&rsquo;s context window</span>
      </span>
    </label>
  );
}

function ConfigDirField({ instance, onPatch }: { instance: ProviderInstance; onPatch: (patch: InstancePatch) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-foreground">
        {instance.driver === "opencode" ? "OpenCode config folder (shared CLI login)" : instance.driver === "codex" ? "CODEX_HOME folder" : "CLAUDE_CONFIG_DIR folder"}
      </span>
      {isDefaultInstance(instance) ? (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          {instance.driver === "opencode" ? "Uses the native OpenCode CLI login. A config folder does not isolate credentials." : "Empty — this is the base login. Telar leaves the config variable unset to preserve its credential store."}
        </p>
      ) : (
        <>
          <BlurInput
            value={instance.configDir ?? ""}
            onCommit={(next) => onPatch({ configDir: next.trim() || null })}
            placeholder="~/.claude-work"
            className="mt-1.5 h-8 font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="mt-1 block text-2xs text-muted-foreground">The folder this login is already signed in with. It must already exist.</span>
        </>
      )}
    </label>
  );
}

function BinaryPathField({ instance, onPatch }: { instance: ProviderInstance; onPatch: (patch: InstancePatch) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-foreground">Binary path</span>
      <BlurInput
        value={instance.binaryPath ?? ""}
        onCommit={(next) => onPatch({ binaryPath: next.trim() || null })}
        placeholder={instance.driver}
        className="mt-1.5 h-8 font-mono text-xs"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="mt-1 block text-2xs text-muted-foreground">
        Empty uses <code className="font-mono">{instance.driver}</code> as your shell would resolve it. A bare name looks that name up on PATH; a full
        path runs exactly that file. Beats{" "}
        <code className="font-mono">{instance.driver === "opencode" ? "OPENCODE_BIN" : instance.driver === "codex" ? "CODEX_BIN" : "CLAUDE_CODE_EXECUTABLE"}</code> when both are
        set.
      </span>
    </label>
  );
}

export function ProviderConfigurationTab({
  instance,
  probe,
  signInCommand,
  onPatch,
  onUpdateCli,
  updating,
  error,
}: {
  instance: ProviderInstance;
  probe?: ProviderProbe | undefined;
  signInCommand: string;
  onPatch: (patch: InstancePatch) => void;
  onUpdateCli?: (() => void) | undefined;
  updating?: boolean | undefined;
  error?: string | null | undefined;
}) {
  const title = displayNameOf(instance);
  const needsSignIn = probe?.signIn === "signed-out" || probe?.signIn === "missing-config-dir";
  const advisory = updateAdvisory(probe, DRIVER_LABEL[instance.driver]);
  return (
    <div className="space-y-4">
      {advisory && <UpdateAdvisory advisory={advisory} driver={instance.driver} onUpdateCli={onUpdateCli} updating={updating} />}

      {needsSignIn && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">Sign in</span>
          <CopyCommand command={signInCommand} />
          <p className="text-2xs text-muted-foreground/70">Run this in your terminal. Telar reads the result — it never signs in for you.</p>
        </div>
      )}

      <label className="block">
        <span className="text-xs font-medium text-foreground">Display name</span>
        <BlurInput
          value={instance.displayName ?? ""}
          onCommit={(next) => onPatch({ displayName: next.trim() || null })}
          placeholder={title}
          className="mt-1.5 h-8 text-xs"
        />
        <span className="mt-1 block text-2xs text-muted-foreground">Shown in the pickers. The routing key ({instance.id}) never changes.</span>
      </label>

      <div>
        <span className="text-xs font-medium text-foreground">Accent colour</span>
        <div className="mt-1.5">
          <AccentPicker {...(instance.accentColor ? { value: instance.accentColor } : {})} onChange={(accentColor) => onPatch({ accentColor })} />
        </div>
        <span className="mt-1 block text-2xs text-muted-foreground">Tells this login apart from another on the same provider.</span>
      </div>

      <ContextNoticeField instance={instance} onPatch={onPatch} />
      <ConfigDirField instance={instance} onPatch={onPatch} />
      <BinaryPathField instance={instance} onPatch={onPatch} />

      <CompactionField driver={instance.driver} value={instance.autoCompact} onChange={(autoCompact) => onPatch({ autoCompact })} />

      <div>
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <div className="mt-1.5">
          <EnvEditor key={instance.updatedAt} env={instance.env} onChange={(env) => onPatch({ env })} />
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
