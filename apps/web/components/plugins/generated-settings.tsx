"use client";

/**
 * THE GENERATED SETTINGS ROWS — a plugin's schema, drawn as the same Rows every
 * other pane uses. The default pane for any plugin with no bespoke one; see
 * `lib/plugins/settings-form.ts` for what a schema field becomes.
 *
 * EVERY WRITE IS THE WHOLE BLOB. The engine replaces a plugin's settings
 * entry whole and validates it with the plugin's own schema, so a row writes
 * `{...current, [key]: value}` — or drops the key to go back to the default
 * (or, at project scope, to what the Mac says). A refused write leaves the
 * control on the stored value and says why under the row.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { describeValue, parseNumberField, type SettingsField } from "@/lib/plugins/settings-form";
import { Dropdown, Row } from "@/components/settings/settings-shell";

const INHERIT = "__inherit";

export type GeneratedSettingsProps = {
  fields: readonly SettingsField[];
  /** What this scope stores now. */
  values: Readonly<Record<string, unknown>>;
  /** The Mac's values, for a PROJECT field that `inherits` one. Absent at machine scope. */
  inherited?: Readonly<Record<string, unknown>>;
  /** Write the whole blob; reject with the engine's sentence to refuse. */
  onWrite: (next: Record<string, unknown>) => Promise<void>;
  disabled?: boolean;
};

export function GeneratedSettingsRows({ fields, values, inherited, onWrite, disabled = false }: GeneratedSettingsProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const write = async (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setErrors(({ [key]: _cleared, ...rest }) => rest);
    try {
      await onWrite(next);
    } catch (cause) {
      setErrors((current) => ({ ...current, [key]: cause instanceof Error ? cause.message : String(cause) }));
    }
  };

  return (
    <>
      {fields.map((field) => (
        <GeneratedRow
          key={field.key}
          field={field}
          value={values[field.key]}
          {...(inherited && field.inherits ? { inheritsFrom: inherited[field.inherits], inherits: true } : {})}
          disabled={disabled}
          {...(errors[field.key] ? { error: errors[field.key] } : {})}
          onChange={(value) => void write(field.key, value)}
        />
      ))}
    </>
  );
}

function GeneratedRow({
  field,
  value,
  inherits = false,
  inheritsFrom,
  disabled,
  error,
  onChange,
}: {
  field: SettingsField;
  value: unknown;
  /** This project field falls back to the Mac's value when unset. */
  inherits?: boolean;
  inheritsFrom?: unknown;
  disabled: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  // What an unset field means: the Mac's value when it inherits one, the
  // schema's default otherwise.
  const fallback = inherits ? inheritsFrom : field.defaultValue;
  const inheritLabel = `Inherit (${describeValue(inheritsFrom) ?? "not set"})`;
  const set = value !== undefined;
  const common = {
    label: field.label,
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.info ? { info: field.info } : {}),
    ...(error ? { error } : {}),
    // Back to the default (or the Mac's value) — only when something is set.
    ...(set && !disabled ? { onRevert: () => onChange(undefined) } : {}),
  };

  if (field.kind === "toggle" && !inherits) {
    return (
      <Row
        {...common}
        control={
          <Switch
            checked={(value ?? fallback) === true}
            disabled={disabled}
            onCheckedChange={(next: boolean) => onChange(next)}
            aria-label={field.label}
          />
        }
      />
    );
  }

  if (field.kind === "toggle" || field.kind === "select") {
    const choices =
      field.kind === "toggle"
        ? [
            { value: "true", label: "On" },
            { value: "false", label: "Off" },
          ]
        : (field.options ?? []).map((option) => ({ value: option, label: option }));
    const current = set ? String(value) : inherits ? INHERIT : String(fallback ?? choices[0]?.value ?? "");
    return (
      <Row
        {...common}
        control={
          <Dropdown<string>
            value={current}
            label={field.label}
            disabled={disabled}
            onChange={(next) =>
              onChange(next === INHERIT ? undefined : field.kind === "toggle" ? next === "true" : next)
            }
            options={[...(inherits ? [{ value: INHERIT, label: inheritLabel }] : []), ...choices]}
          />
        }
      />
    );
  }

  // Text, path and number: typed, committed on blur or Enter.
  return (
    <Row
      {...common}
      control={
        <FieldInput
          key={String(value ?? "")}
          field={field}
          value={set ? String(value) : ""}
          placeholder={inherits ? inheritLabel : (describeValue(field.defaultValue) ?? "")}
          disabled={disabled}
          onCommit={onChange}
        />
      }
    />
  );
}

/**
 * COMMITTED ON BLUR, like every typed settings field: each commit is an HTTP
 * write, and one per keystroke would race. Empty means unset.
 */
function FieldInput({
  field,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  field: SettingsField;
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState<string>();
  const commit = () => {
    if (draft === value) return;
    if (field.kind !== "number") return onCommit(draft.trim() === "" ? undefined : draft);
    const parsed = parseNumberField(field, draft);
    if ("error" in parsed) return setInvalid(parsed.error);
    setInvalid(undefined);
    onCommit(parsed.value);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={field.kind === "number" ? "decimal" : undefined}
        className={field.kind === "path" ? "h-8 w-64 font-mono text-2xs" : "h-8 w-48"}
        aria-label={field.label}
        {...(invalid ? { "aria-invalid": true } : {})}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            setInvalid(undefined);
          }
        }}
      />
      {invalid && <span className="text-2xs text-destructive">{invalid}</span>}
    </div>
  );
}
