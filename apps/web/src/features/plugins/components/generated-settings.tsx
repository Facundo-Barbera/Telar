"use client";

import { useState, type ComponentType } from "react";
import { BlocksIcon, FileTextIcon, FlaskConicalIcon, FolderIcon, PackagePlusIcon, PlugIcon, SettingsIcon } from "lucide-react";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import { describeValue, parseNumberField, type SettingsField } from "../settings-form";
import { Dropdown, Row } from "@/features/settings";

const INHERIT = "__inherit";

const ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  settings: SettingsIcon,
  "package-plus": PackagePlusIcon,
  "flask-conical": FlaskConicalIcon,
  folder: FolderIcon,
  "file-text": FileTextIcon,
  plug: PlugIcon,
};

export function pluginIcon(name: string | undefined): ComponentType<{ className?: string }> {
  const key = name?.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return (key && Object.hasOwn(ICONS, key) ? ICONS[key] : undefined) ?? BlocksIcon;
}

export type GeneratedSettingsProps = {
  fields: readonly SettingsField[];
  values: Readonly<Record<string, unknown>>;
  inherited?: Readonly<Record<string, unknown>>;
  onWrite: (next: Record<string, unknown>) => Promise<void>;
  disabled?: boolean;
};

export function GeneratedSettingsRows({ fields, values, inherited, onWrite, disabled = false }: GeneratedSettingsProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const write = async (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setErrors((current) => {
      const rest = { ...current };
      delete rest[key];
      return rest;
    });
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
  inherits?: boolean;
  inheritsFrom?: unknown;
  disabled: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const fallback = inherits ? inheritsFrom : field.defaultValue;
  const shown = (raw: unknown) => (typeof raw === "string" && field.optionLabels?.[raw]) || describeValue(raw);
  const inheritLabel = `Inherit (${shown(inheritsFrom) ?? "not set"})`;
  const set = value !== undefined;
  const icon = field.icon ? ICONS[field.icon] : undefined;
  const common = {
    label: field.label,
    ...(icon ? { icon } : {}),
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.info ? { info: field.info } : {}),
    ...(error ? { error } : {}),
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
        : (field.options ?? []).map((option) => ({ value: option, label: field.optionLabels?.[option] ?? option }));
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
