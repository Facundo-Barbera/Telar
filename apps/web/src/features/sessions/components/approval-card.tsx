"use client";

import { useState } from "react";
import { FileIcon, KeyRoundIcon, MessageCircleQuestionIcon, PencilIcon, ShieldIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import { displayToolName, type EngineRequest, type RequestDecision, type SecretAccessDetail, type UserInputField } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { cardSurface } from "@/ui/card";
import { CodeSurface } from "@/ui/code-surface";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { isMultiChoice } from "@/features/composer";

const KIND_ICON = {
  command_execution: TerminalIcon,
  file_change: PencilIcon,
  file_read: FileIcon,
  tool_call: WrenchIcon,
  user_input: MessageCircleQuestionIcon,
  secret_access: KeyRoundIcon,
} as const;

function describeRequest(detail: EngineRequest["detail"]): { eyebrow: string; verb: string; argument?: string } {
  switch (detail.kind) {
    case "command_execution":
      return { eyebrow: "command", verb: "Run", argument: detail.command.command };
    case "file_change":
      return { eyebrow: "file change", verb: capitalise(detail.change.kind), argument: detail.change.path };
    case "file_read":
      return { eyebrow: "file read", verb: "Read", argument: detail.read.path };
    case "tool_call":
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

const CARD = `flex flex-col gap-3 p-3 ${cardSurface("warning")}`;
const EYEBROW = "font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase";

function Field({ field, value, onChange }: { field: UserInputField; value: unknown; onChange: (next: unknown) => void }) {
  const id = `request-field-${field.key}`;
  const title = (
    <span className="text-xs font-medium" id={`${id}-label`}>
      {field.label}
      {field.required && <span className="ml-0.5 text-warning">*</span>}
    </span>
  );

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
        <Button type="button" variant="ghost" size="sm" disabled={sending} onClick={() => onDecide(request.id, "cancel")}>
          Cancel the turn
        </Button>
      </div>
    </form>
  );
}

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
            <span className="ml-auto flex items-center gap-2 font-mono text-3xs text-muted-foreground">
              {candidate.vault && <span>{candidate.vault}</span>}
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
            <span id={`secret-remember-scope-${request.id}`} className="text-muted-foreground">
              Only “{secret.candidates.find((candidate) => candidate.id === itemId)?.title ?? "the item you pick"}”, only {kinds}, only this
              profile and this exact address. 1Password still asks to unlock. Revoke in Settings → Browser.
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
          <span className="font-mono text-3xs leading-tight font-normal text-muted-foreground">for this session</span>
        </Button>
        <Button variant="ghost" disabled={sending} onClick={() => onDecide(request.id, "decline")} className="text-destructive hover:text-destructive">
          Deny
        </Button>
      </div>
    </section>
  );
}
