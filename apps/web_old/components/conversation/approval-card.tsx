"use client";

// APPROVAL CARD — one component for the moment a human is asked to approve
// something an agent proposes. UX-DR7, and the resolution of readiness finding
// UX-2 (it had been classified three ways; the PRIMITIVE reading wins).
//
// WHY A PRIMITIVE AND NOT A REGISTERED KIND. As a namespaced kind it would have
// to be either `loom:approval-card` or `workspace:approval-card`; whichever
// module owned it, the other would be registering a foreign-namespaced kind —
// breaking AD-13 — and if they each registered their own, "one component, one
// protocol shape" is dead on arrival. As a primitive, ANY module's kind renders
// it. (ARCHITECTURE-SPINE.md's "looms module + ApprovalCard item kind" wording
// is the outlier here; epics.md says so explicitly.)
//
// THE MERGE. Two implementations existed: production's PermissionCard (in
// session-view.tsx) had the real machinery — the input preview, the rule string,
// the narrow→broad rule disclosure, Allow once / Always allow / Deny — and the
// demo gate card (lib/demo-gallery/prep-gate/gate.tsx) had the vocabulary the
// design asked for: a mono-uppercase header reading "tool call — awaiting your
// approval", the proposal text, Approve / Hold. This is one component carrying
// both, with the button labels a PROP. Two vocabularies for one moment was the
// drift; one component with a labelled protocol is the fix.
//
// THE MOAT (AD-1 / AD-10). This card RENDERS an approval; it never DECIDES one.
// There is no auto-approve, no default-approve, and no "remember" that bypasses
// the server's rule — `onRespond` is called with exactly what the human clicked
// and the server remains the only gate. Do not add a prop that resolves a card
// without a click.
//
// CALLBACK-OPTIONAL, DELIBERATELY. With `onRespond` absent the card renders
// READ-ONLY. That is not a degraded mode bolted on afterwards: it is the
// mechanism that lets one kind render on every surface, including a read-only
// transcript that has no way to answer (story 6.6's TranscriptView).
//
// THE HEADER LABELS A MOMENT, NOT A CARD, so it is rendered only while the card
// is PENDING. Both vocabularies the merge inherited are written in the
// awaiting-you voice ("tool call — awaiting your approval", "node advance —
// awaiting your approval"), and a resolved card renders an `Allowed`/`Denied`
// badge two rows below it: the pair read together as "awaiting your approval …
// Allowed", which is a false label on the consent surface. A resolved card
// therefore drops the header and reads exactly like the donor's `PermissionCard`
// did — which had no header at all. The decision is `approvalHeader` below,
// a pure function, because there is no DOM harness in this repo and a pure
// function is the only shape a test can hold.

import { ChevronRightIcon, ShieldAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useState } from "react";

/** The two vocabularies this one component speaks. A tool permission reads
 *  Allow once / Always allow / Deny; a node advance reads Approve / Hold. */
export type ApprovalLabels = {
  allow: string;
  /** Omitted ⇒ no "always" affordance and no rule disclosure (the gate-card
   *  vocabulary, where "always" is meaningless). */
  always?: string;
  deny: string;
};

export const TOOL_APPROVAL_LABELS: ApprovalLabels = {
  allow: "Allow once",
  always: "Always allow",
  deny: "Deny",
};

export const ADVANCE_APPROVAL_LABELS: ApprovalLabels = {
  allow: "Approve",
  deny: "Hold",
};

/** The default header, in the gate card's own words. It is the PENDING label —
 *  see `approvalHeader`. */
export const PENDING_APPROVAL_HEADER = "tool call — awaiting your approval";

export type ApprovalCardProps = {
  /** Machine-voiced, lower-case, mono-uppercased by the style. Labels the
   *  moment the card is ASKING about, so it renders only while `pending`. */
  header?: string;
  /** What is being proposed — the tool name, or the node/step being advanced. */
  title: string;
  /** The salient preview of the proposal: a path, a command, the proposal text. */
  preview: string;
  /** The rule an "always" would persist. Absent ⇒ no rule row. */
  rule?: string;
  /** Narrow → broad choices offered for this call. The USER picks how wide an
   *  "always" persists — never a heuristic. */
  ruleOptions?: ReadonlyArray<{ rule: string; label: string }>;
  status: "pending" | "allowed" | "denied";
  labels?: ApprovalLabels;
  /** The sub-agent whose call this is. Absent ⇒ the session's own turn is
   *  asking, which is the common case and reads without any attribution. */
  agentId?: string;
  /** Absent ⇒ read-only. See the header. */
  onRespond?: (behavior: "allow" | "deny", always: boolean, rule?: string) => void;
  className?: string;
};

/**
 * The header line to render, or `null` for none — a PURE FUNCTION so the rule
 * above is asserted rather than intended (`approval-card.test.ts`). A resolved
 * card has no header: its state is carried by the badge, and the header's own
 * vocabulary contradicts it.
 *
 * WHY THE ASKER GOES IN THE HEADER. The route gates every tool a sub-agent
 * calls through the same permission path the main turn uses — deliberately, so
 * a sub-agent cannot skip the project's guardrails. With several agents live
 * that produces several cards at once, and until now they were identical:
 * nothing on any of them said who was asking. A queue of anonymous prompts is a
 * queue nobody can answer, which is exactly what it looked like in practice.
 *
 * An explicit `header` still wins. Callers that already name the moment (a loom
 * gate, a weave) are naming something more specific than the asker, and this
 * must not overwrite them.
 */
export function approvalHeader(
  status: ApprovalCardProps["status"],
  header?: string,
  agentId?: string,
): string | null {
  if (status !== "pending") return null;
  if (header) return header;
  // Absent agentId means the session's own turn is asking. That is the common
  // case and it keeps the original wording — saying "main" here would be noise
  // on every card in a single-agent session.
  return agentId ? `subagent ${agentId} — awaiting your approval` : PENDING_APPROVAL_HEADER;
}

export function ApprovalCard({
  header,
  title,
  preview,
  rule,
  ruleOptions = [],
  status,
  labels = TOOL_APPROVAL_LABELS,
  agentId,
  onRespond,
  className,
}: ApprovalCardProps) {
  // The user picks how broad an "Always allow" is — never a heuristic. Plain
  // click on "Always allow" uses the default (prefix) option, `rule`; the caret
  // reveals the other offered options (narrower exact match, and — unless the
  // command is dangerous — a broader command-wide rule) as a tiny inline list,
  // not a new overlay/select (no programmatic .focus() anywhere here —
  // WebKit 26.x).
  const [showOptions, setShowOptions] = useState(false);
  const otherOptions = ruleOptions.filter((o) => o.rule !== rule);
  const canAlways = labels.always !== undefined && rule !== undefined;
  const headerLine = approvalHeader(status, header, agentId);

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-xs",
        className,
      )}
    >
      {headerLine !== null && (
        <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
          {headerLine}
        </p>
      )}
      <div className="flex items-center gap-1.5 font-medium">
        <ShieldAlertIcon className="size-3.5 text-muted-foreground" />
        {title}
      </div>
      <div className="overflow-x-auto rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="whitespace-pre-wrap break-all">{preview}</span>
      </div>
      {rule !== undefined && (
        <div className="text-[10px] text-muted-foreground">
          rule <span className="font-mono text-foreground/80">{rule}</span>
        </div>
      )}
      {status === "pending" ? (
        onRespond ? (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => onRespond("allow", false)}
              >
                {labels.allow}
              </Button>
              {canAlways && (
                <div className="flex items-stretch overflow-hidden rounded-md border">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="h-auto flex-col items-start gap-0 rounded-none border-0 py-1"
                    onClick={() => onRespond("allow", true)}
                  >
                    <span>{labels.always}</span>
                    <span className="font-mono text-[9px] font-normal text-muted-foreground">
                      {rule}
                    </span>
                  </Button>
                  {otherOptions.length > 0 && (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="rounded-none border-0 border-l px-1"
                      aria-label={showOptions ? "Hide other rule choices" : "More rule choices"}
                      onClick={() => setShowOptions((s) => !s)}
                    >
                      <ChevronRightIcon
                        className={cn("size-3 transition-transform", showOptions && "rotate-90")}
                      />
                    </Button>
                  )}
                </div>
              )}
              <Button
                type="button"
                size="xs"
                variant="destructive"
                onClick={() => onRespond("deny", false)}
              >
                {labels.deny}
              </Button>
            </div>
            {showOptions && otherOptions.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border bg-background/40 p-1.5">
                {otherOptions.map((o) => (
                  <Button
                    key={o.rule}
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-auto w-fit flex-col items-start gap-0 px-1.5 py-1"
                    onClick={() => onRespond("allow", true, o.rule)}
                  >
                    <span>{o.label}</span>
                    <span className="font-mono text-[9px] font-normal text-muted-foreground">
                      {o.rule}
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : (
          // READ-ONLY: this surface cannot answer, so it says so rather than
          // rendering buttons that would do nothing.
          <Badge variant="outline" className="w-fit text-[10px]">
            Awaiting approval
          </Badge>
        )
      ) : (
        <Badge
          variant={status === "allowed" ? "secondary" : "destructive"}
          className="w-fit text-[10px]"
        >
          {status === "allowed" ? "Allowed" : "Denied"}
        </Badge>
      )}
    </div>
  );
}
