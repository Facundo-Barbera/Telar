"use client";

import { useRef } from "react";
import { CornerDownLeftIcon, LayersIcon, SquareIcon } from "lucide-react";
import type { ProviderDriverKind } from "@telar/engine-client";
import type { ModelChoice } from "@/features/providers";
import { InputGroupButton } from "@/ui/input-group";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/ui/utils";
import { useSwapFade } from "../hooks/use-composer-motion";
import type { ComposerStash } from "../hooks/use-composer-stash";
import { AccessControl } from "./access-control";
import { AgentControl } from "./agent-control";
import { ComposerOverflowMenu } from "./composer-overflow-menu";
import { ControlDivider } from "./control-primitives";
import { ReasoningControl } from "./reasoning-control";
import type { ComposerProps } from "./composer-props";

/** Never `disabled`: InputGroup's has-disabled greys the whole composer. An empty send is a no-op instead. */
export function SendButton({
  busy,
  sending,
  hasContent,
  escArmed,
  question,
  onStop,
  animate,
}: {
  busy: boolean;
  sending: boolean;
  hasContent: boolean;
  escArmed: boolean;
  /** In question mode the button submits the form; the drawer keeps its own cancel. */
  question?: { label: string; ready: boolean };
  onStop: () => void;
  animate: boolean;
}) {
  const icon = useRef<HTMLSpanElement>(null);
  const stopping = busy && (escArmed || !hasContent) && !question;
  const label = question?.label ?? (escArmed ? "Press Escape again to stop" : stopping ? "Stop" : "Send");
  const armed = escArmed && !question;
  useSwapFade(icon, armed ? "esc" : stopping ? "stop" : sending ? "sending" : "send", animate);
  return (
    <InputGroupButton
      type={stopping ? "button" : "submit"}
      variant="default"
      size="icon-sm"
      aria-label={label}
      title={question ? question.label : undefined}
      onClick={stopping ? onStop : undefined}
      className={cn(armed && "bg-destructive text-background hover:bg-destructive", !busy && !hasContent && "opacity-60", question && !question.ready && "opacity-60")}
    >
      <span ref={icon} className="flex items-center justify-center">
        {armed ? (
          <span className="text-3xs leading-none font-semibold tracking-tight">ESC</span>
        ) : stopping ? (
          <SquareIcon className="size-4" />
        ) : sending ? (
          <Spinner />
        ) : (
          <CornerDownLeftIcon className="size-4" />
        )}
      </span>
    </InputGroupButton>
  );
}

/** Hidden while the stash is empty; an agent's unread draft tints it. */
export function StashBadge({ stash }: { stash: ComposerStash }) {
  const { shelf, open, stashing } = stash;
  if (shelf.rows.length === 0 && !stashing) return null;
  const agents = shelf.agents.length > 0;
  return (
    <button
      type="button"
      aria-label={agents ? "Prompts waiting to be sent, including drafts an agent wrote" : "Stashed prompts"}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={agents ? "Prompts waiting — an agent drafted one (⌘S)" : "Stashed prompts (⌘S)"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={stash.toggle}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        open && "bg-accent text-foreground",
        !open && agents && "text-primary",
      )}
    >
      <LayersIcon className="size-4" />
      {stashing ? <Spinner /> : <span className="text-xs tabular-nums">{shelf.rows.length}</span>}
    </button>
  );
}

type PillProps = Pick<
  ComposerProps,
  "fresh" | "runtimeMode" | "envMode" | "onModelChange" | "onRuntimeMode" | "onDriverChange" | "onEnvMode" | "onResumeAfterRateLimit"
> & {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  instanceId: string | undefined;
  resumeAfterRateLimit: boolean | undefined;
  ultrathink: { active: boolean; toggle: () => void };
};

/** The pills while the composer's own container is wide enough, else the `···` menu carrying all of them. */
export function ComposerPills(props: PillProps) {
  const { driver, choice, instanceId, runtimeMode, onModelChange, onRuntimeMode, onDriverChange, onEnvMode, onResumeAfterRateLimit, resumeAfterRateLimit, ultrathink } = props;
  const shared = { driver, choice, ...(instanceId ? { instanceId } : {}), ...(onModelChange ? { onChange: onModelChange } : {}) };
  const limit = { ...(resumeAfterRateLimit === undefined ? {} : { resumeAfterRateLimit }), ...(onResumeAfterRateLimit ? { onResumeAfterRateLimit } : {}) };
  return (
    <>
      <AgentControl {...shared} {...(onDriverChange ? { onDriverChange } : {})} />
      <div className="hidden items-center gap-1 @2xl/composer:flex">
        <ControlDivider />
        <ReasoningControl {...shared} ultrathink={ultrathink} />
        {runtimeMode && (
          <>
            <ControlDivider />
            <AccessControl runtimeMode={runtimeMode} onRuntimeMode={onRuntimeMode} driver={driver} {...limit} />
          </>
        )}
      </div>
      <div className="@2xl/composer:hidden">
        <ComposerOverflowMenu
          {...shared}
          ultrathink={ultrathink}
          fresh={props.fresh ?? false}
          {...(runtimeMode ? { runtimeMode, onRuntimeMode } : {})}
          {...(props.envMode ? { envMode: props.envMode } : {})}
          {...(onDriverChange ? { onDriverChange } : {})}
          {...(onEnvMode ? { onEnvMode } : {})}
          {...limit}
        />
      </div>
    </>
  );
}
