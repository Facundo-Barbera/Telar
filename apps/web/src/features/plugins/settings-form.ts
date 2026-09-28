import type { PluginStatus } from "@telar/engine-client";
import { foldForSearch, settingsRowId, type SettingsSearchEntry } from "@/features/settings/index";

type SettingsFieldKind = "toggle" | "select" | "text" | "path" | "number";

export type SettingsField = {
  key: string;
  kind: SettingsFieldKind;
  label: string;
  hint?: string;
  info?: string;
  options?: readonly string[];
  optionLabels?: Readonly<Record<string, string>>;
  icon?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  defaultValue?: unknown;
  inherits?: string;
};

type JsonProperty = {
  type?: string | string[];
  enum?: unknown[];
  title?: string;
  description?: string;
  info?: string;
  widget?: string;
  inherits?: string;
  labels?: Record<string, string>;
  icon?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  anyOf?: JsonProperty[];
};

function unwrap(property: JsonProperty): JsonProperty {
  if (!property.anyOf) return property;
  const concrete = property.anyOf.filter((option) => option.type !== "null");
  if (concrete.length !== 1) return property;
  const { anyOf: _anyOf, ...outer } = property;
  void _anyOf;
  return { ...concrete[0], ...outer };
}

function humanise(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function kindOf(property: JsonProperty): SettingsFieldKind | undefined {
  const type = Array.isArray(property.type) ? property.type.find((entry) => entry !== "null") : property.type;
  if (property.enum && property.enum.every((value) => typeof value === "string")) return "select";
  if (type === "boolean") return "toggle";
  if (type === "number" || type === "integer") return "number";
  if (type === "string") return property.widget === "path" ? "path" : "text";
  return undefined;
}

export function settingsFields(schema: Record<string, unknown> | undefined): SettingsField[] {
  const properties = (schema?.properties ?? {}) as Record<string, JsonProperty>;
  const fields: SettingsField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const property = unwrap(raw);
    const kind = kindOf(property);
    if (!kind) continue;
    const types = Array.isArray(property.type) ? property.type : [property.type];
    fields.push({
      key,
      kind,
      label: property.title ?? humanise(key),
      ...(property.description ? { hint: property.description } : {}),
      ...(property.info ? { info: property.info } : {}),
      ...(kind === "select" ? { options: property.enum as string[] } : {}),
      ...(kind === "select" && property.labels ? { optionLabels: property.labels } : {}),
      ...(property.icon ? { icon: property.icon } : {}),
      ...(property.minimum !== undefined ? { min: property.minimum } : {}),
      ...(property.maximum !== undefined ? { max: property.maximum } : {}),
      ...(types.includes("integer") ? { integer: true } : {}),
      ...(property.default !== undefined ? { defaultValue: property.default } : {}),
      ...(property.inherits ? { inherits: property.inherits } : {}),
    });
  }
  return fields;
}

export function parseNumberField(field: SettingsField, text: string): { value: number | undefined } | { error: string } {
  if (text.trim() === "") return { value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: "Enter a number." };
  if (field.integer && !Number.isInteger(value)) return { error: "Enter a whole number." };
  if (field.min !== undefined && value < field.min) return { error: `At least ${field.min}.` };
  if (field.max !== undefined && value > field.max) return { error: `At most ${field.max}.` };
  return { value };
}

export function describeValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

export function generatedGroupTitle(status: PluginStatus, scope: "project" | "machine"): string {
  const section = status.meta.settings.find((entry) => entry.scope === scope);
  return section?.label ?? status.meta.name;
}

export function pluginSettingsSearchEntries(
  plugins: readonly PluginStatus[],
  pages: Record<"project" | "machine", { id: string; label: string }>,
  bespoke: (scope: "project" | "machine", pluginId: string) => boolean = () => false,
): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  for (const status of plugins) {
    for (const scope of ["project", "machine"] as const) {
      if (bespoke(scope, status.meta.id)) continue;
      const schema = scope === "project" ? status.settingsSchema : status.machineSettingsSchema;
      const page = pages[scope];
      const group = generatedGroupTitle(status, scope);
      for (const field of settingsFields(schema)) {
        entries.push({
          id: settingsRowId({ page: page.id, group, label: field.label }),
          title: field.label,
          ...(field.hint ? { hint: field.hint } : {}),
          group,
          pageId: page.id,
          pageLabel: page.label,
          folded: {
            title: foldForSearch(field.label),
            hint: foldForSearch([field.hint, status.meta.name, "plugin"].filter(Boolean).join(" ")),
            place: foldForSearch(`${group} ${page.label}`),
          },
        });
      }
    }
  }
  return entries;
}
