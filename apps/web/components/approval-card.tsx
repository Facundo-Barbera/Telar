"use client";

import { useState } from "react";
import { FileIcon, KeyRoundIcon, MessageCircleQuestionIcon, PencilIcon, ShieldIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import { displayToolName, type EngineRequest, type RequestDecision, type SecretAccessDetail, type UserInputField } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { CodeSurface } from "@/components/ui/code-surface";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { isMultiChoice } from "@/lib/question-drawer";

/**
 * A parked request.
 *
 * SHOWN AT THE TOP OF THE TURN, not inline in the timeline: it is the one thing
 * blocking progress — everything below it has already happened and nothing more
 * will happen until this is answered.
 *
 * FOUR PARTS, in the frozen app's order, because they answer four questions in
 * the order a person asks them: a mono eyebrow naming the KIND of decision, the
 * verb with a shield, the ARGUMENT in an inset box, then the choices.
 *
 * TWO VOCABULARIES, because there are two different things being asked.
 * A PERMISSION ("may I run this?") takes Allow once / Always allow / Deny. A
 * QUESTION (`user_input`) takes a form and an answer — offering it Allow/Deny
 * would be asking the human to permit a question rather than answer it. The
 * frozen app splits these the same way.
 *
 * WHAT THIS DELIBERATELY DOES NOT COPY. The donor's middle button reads
 * `Always allow` over a rule glob — `Edit(apps/web/components/**)` — because
 * that app's permission layer writes path-scoped rules. THIS engine's
 * `acceptForSession` is exactly what its name says: this session, no glob, no
 * persistence past it. Printing a rule here would be a lie in the one place a
 * person is deciding how much rope to hand over, so the button states the real
 * scope instead. If the engine grows rule-scoped approvals, the glob belongs
 * here — not before.
 *
 * --warning, not --destructive: a request is a QUESTION. Red would say the
 * session had failed, which turns a routine confirmation into an alarm.
 */

const KIND_ICON = {
  command_execution: TerminalIcon,
  file_change: PencilIcon,
  file_read: FileIcon,
  tool_call: WrenchIcon,
  user_input: MessageCircleQuestionIcon,
  secret_access: KeyRoundIcon,
} as const;

export function describeRequest(detail: EngineRequest["detail"]): { eyebrow: string; verb: string; argument?: string } {
  switch (detail.kind) {
    case "command_execution":
      return { eyebrow: "command", verb: "Run", argument: detail.command.command };
    case "file_change":
      return { eyebrow: "file change", verb: capitalise(detail.change.kind), argument: detail.change.path };
    case "file_read":
      return { eyebrow: "file read", verb: "Read", argument: detail.read.path };
    case "tool_call":
      // `browser_click`, not `mcp__telar__browser_click`. The qualified name is
      // addressing; a human being asked to permit something reads the verb.
      return { eyebrow: "tool call", verb: displayToolName(detail.call.name) };
    case "user_input":
      return { eyebrow: "question", verb: detail.prompt };
    case "secret_access":
      return { eyebrow: "1password", verb: `Fill login on ${detail.secret.origin}` };
  }
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * THE APPROVAL CARD IS A CARD, TINTED — not a fourth box that happens to be
 * round. The shape comes from `cardSurface` (ui/card.tsx), which is the same
 * radius, fill and hairline the `Card` primitive wears; only the spacing is
 * local, because these three cards lay their own children out at a flat `p-3`
 * rather than through Card's --card-spacing slots. The hairline is now a RING
 * rather than a border, which is what the primitive uses: it paints outside the
 * box instead of inside it, so the 1px stops being part of the layout.
 */
const CARD = `flex flex-col gap-3 p-3 ${cardSurface("warning")}`;
const EYEBROW = "font-mono text-[0.625rem] tracking-[0.08em] text-muted-foreground uppercase";

/** One field of a `user_input` request, in the kind the agent asked for. */
function Field({ field, value, onChange }: { field: UserInputField; value: unknown; onChange: (next: unknown) => void }) {
  const id = `request-field-${field.key}`;
  const title = (
    <span className="text-xs font-medium" id={`${id}-label`}>
      {field.label}
      {field.required && <span className="ml-0.5 text-warning">*</span>}
    </span>
  );

  /**
   * A MULTI CHOICE IS A CHECKBOX LIST, NOT A DROPDOWN. A `Select` can only
   * hold one value, so a field asking for several would silently keep the
   * last click and throw the rest away — the human would have answered and
   * watched the answer disappear. Checkboxes also show the whole set at once,
   * which is what a person needs to pick ACROSS options rather than between
   * them.
   *
   * Its own element rather than a branch inside the label below: a label may
   * not contain the per-option labels this needs, so the group names itself
   * through `aria-labelledby` instead.
   */
  if (isMultiChoice(field)) {
    const chosen = Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
    return (
      <div className="flex flex-col gap-1" role="group" aria-labelledby={`${id}-label`}>
        {title}
        {(field.choices ?? []).map((choice) => (
          <label
            key={choice}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-sm has-checked:border-warning/60"
          >
            <input
              type="checkbox"
              checked={chosen.includes(choice)}
              onChange={(event) => onChange(event.target.checked ? [...chosen, choice] : chosen.filter((one) => one !== choice))}
            />
            <span className="min-w-0 flex-1">{choice}</span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      {title}
      {field.kind === "boolean" ? (
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      ) : field.kind === "choice" ? (
        <Select value={typeof value === "string" ? value : ""} onValueChange={(next) => onChange(next ?? "")}>
          <SelectTrigger size="sm" id={id} className="w-full">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {(field.choices ?? []).map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          // `secret` is why this is not always a text input: an API key echoed
          // into a transcript that is written to disk is a real leak.
          type={field.kind === "secret" ? "password" : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function QuestionCard({
  request,
  prompt,
  fields,
  sending,
  onDecide,
}: {
  request: EngineRequest;
  prompt: string;
  fields: readonly UserInputField[];
  sending: boolean;
  onDecide: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const missing = fields.some((field) => {
    if (!field.required) return false;
    const value = answers[field.key];
    // A multi field holds a list, and an EMPTY list is the unanswered state —
    // ticking a box and unticking it must leave the submit as locked as it
    // was before the first tick.
    if (Array.isArray(value)) return value.length === 0;
    return value === undefined || value === "" || value === null;
  });

  return (
    <form
      className={CARD}
      aria-label="Question awaiting your answer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!missing) onDecide(request.id, "accept", { answers });
      }}
    >
      <p className={EYEBROW}>question</p>
      <p className="flex items-start gap-1.5 text-sm">
        <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span className="whitespace-pre-wrap">{prompt}</span>
      </p>

      {fields.length > 0 && (
        <div className="flex flex-col gap-2">
          {fields.map((field) => (
            <Field key={field.key} field={field} value={answers[field.key]} onChange={(next) => setAnswers((current) => ({ ...current, [field.key]: next }))} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={sending || missing}>
          Answer
        </Button>
        {/* `cancel` withdraws the whole turn — the honest option when the
            question cannot be answered. Declining a question would tell the
            agent it was refused permission, which is not what happened. */}
        <Button type="button" variant="ghost" size="sm" disabled={sending} onClick={() => onDecide(request.id, "cancel")}>
          Cancel the turn
        </Button>
      </div>
    </form>
  );
}

/**
 * The 1Password fill card. TWO deliberate absences remain: no free-typed value
 * (the human picks an ITEM; values never pass through this UI), and no
 * candidate outside the engine's domain-matched list (the radio group IS the
 * domain binding, rendered).
 *
 * THE THIRD — "Always allow" — is now a NARROW, EXPLICIT opt-in rather than a
 * button, and the difference is the whole design. `acceptForSession` would
 * widen a KIND for a session; this box authorizes ONE tuple forever: this
 * browser profile, this exact origin, this vault item, these field kinds. It
 * starts UNCHECKED every time, the words say exactly what it covers, and it is
 * only offered when the engine knows which profile the fill lands in — an
 * authorization that cannot name an identity is one nobody could later
 * recognise or revoke. 1Password's own lock is untouched by it.
 */
function SecretAccessCard({
  request,
  secret,
  sending,
  onDecide,
}: {
  request: EngineRequest;
  secret: SecretAccessDetail;
  sending: boolean;
  onDecide: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => void;
}) {
  const [itemId, setItemId] = useState(secret.candidates[0]?.id ?? "");
  /** Unchecked on every render of every card. Nothing pre-ticks this. */
  const [remember, setRemember] = useState(false);
  const kinds = secret.fields.map((field) => (field.kind === "field" ? `“${field.label ?? ""}”` : field.kind)).join(" + ");
  const profile = secret.profile;

  return (
    <section className={CARD} aria-label="Fill from 1Password — approval required">
      <p className={EYEBROW}>1password</p>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRoundIcon className="size-3.5 shrink-0 text-warning" />
        Fill {kinds} on <span className="font-mono">{secret.origin}</span>
      </p>
      {profile && (
        // WHICH IDENTITY this lands in. A person with several accounts is
        // deciding about one of them, and the browser profile is the only
        // thing that says which.
        <p className="text-xs text-muted-foreground">
          In browser profile <span className="font-medium text-foreground">{profile.label ?? profile.id}</span>
          {profile.account && <> · expected account <span className="font-mono">{profile.account}</span></>}
        </p>
      )}

      <div className="flex flex-col gap-1" role="radiogroup" aria-label="1Password item">
        {secret.candidates.map((candidate) => (
          <label
            key={candidate.id}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm has-checked:border-warning/60"
          >
            <input
              type="radio"
              name={`secret-item-${request.id}`}
              value={candidate.id}
              checked={itemId === candidate.id}
              onChange={() => setItemId(candidate.id)}
            />
            <span className="font-medium">{candidate.title}</span>
            <span className="ml-auto flex items-center gap-2 font-mono text-[0.625rem] text-muted-foreground">
              {candidate.vault && <span>{candidate.vault}</span>}
              {/* The matched domain, shown so the human verifies the same
                  binding the engine enforced. */}
              <span>{candidate.domain}</span>
            </span>
          </label>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Telar fills the values directly — they never enter the conversation, the journal, or the model.
      </p>

      {profile && (
        <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            aria-describedby={`secret-remember-scope-${request.id}`}
          />
          <span className="flex flex-col gap-0.5 text-xs">
            <span className="font-medium">
              Allow agents to use this login automatically in {profile.label ?? profile.id} on {secret.origin}
            </span>
            {/* The exact scope, spelled out — the card must not describe a
                narrower permission than the one it is about to store. */}
            <span id={`secret-remember-scope-${request.id}`} className="text-muted-foreground">
              Only “{secret.candidates.find((candidate) => candidate.id === itemId)?.title ?? "the item you pick"}”, only {kinds}, only this
              profile and this exact address. 1Password still asks to unlock. Revoke in Settings → Agent tools.
            </span>
          </span>
        </label>
      )}

      {request.notified === false && (
        <p className="text-xs text-muted-foreground">Parked with nobody watching — no notification was sent.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={sending || !itemId}
          onClick={() => onDecide(request.id, "accept", { answers: { item: itemId, ...(remember ? { remember: true } : {}) } })}
        >
          Fill from 1Password
        </Button>
        <Button variant="ghost" disabled={sending} onClick={() => onDecide(request.id, "decline")} className="text-destructive hover:text-destructive">
          Deny
        </Button>
      </div>
    </section>
  );
}

export function ApprovalCard({
  request,
  sending,
  onDecide,
}: {
  request: EngineRequest;
  sending: boolean;
  onDecide: (requestId: string, decision: RequestDecision, extra?: { answers?: Record<string, unknown> }) => void;
}) {
  if (request.detail.kind === "user_input") {
    return <QuestionCard request={request} prompt={request.detail.prompt} fields={request.detail.fields} sending={sending} onDecide={onDecide} />;
  }
  if (request.detail.kind === "secret_access") {
    return <SecretAccessCard request={request} secret={request.detail.secret} sending={sending} onDecide={onDecide} />;
  }

  const { eyebrow, verb, argument } = describeRequest(request.detail);
  const Icon = KIND_ICON[request.detail.kind] ?? ShieldIcon;

  return (
    <section className={CARD} aria-label="Approval required">
      <p className={EYEBROW}>{eyebrow}</p>

      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-3.5 shrink-0 text-warning" />
        {verb}
      </p>

      {argument && (
        <CodeSurface text={argument} wrap tone="foreground" />
      )}

      {/* A request that parked with nobody watching is the case a detached
          session most needs surfaced — it is why this line is still here. */}
      {request.notified === false && (
        <p className="text-xs text-muted-foreground">Parked with nobody watching — no notification was sent.</p>
      )}

      <div className="flex flex-wrap items-stretch gap-2">
        <Button size="sm" disabled={sending} onClick={() => onDecide(request.id, "accept")}>
          Allow once
        </Button>
        <Button
          variant="outline"
          disabled={sending}
          onClick={() => onDecide(request.id, "acceptForSession")}
          className="h-auto flex-col items-start gap-0 px-2.5 py-1 text-left"
        >
          <span className="text-sm leading-tight font-medium">Always allow</span>
          {/* The real scope, stated. See the note above on why this is not a glob. */}
          <span className="font-mono text-[0.625rem] leading-tight font-normal text-muted-foreground">for this session</span>
        </Button>
        <Button variant="ghost" disabled={sending} onClick={() => onDecide(request.id, "decline")} className="text-destructive hover:text-destructive">
          Deny
        </Button>
      </div>
    </section>
  );
}
