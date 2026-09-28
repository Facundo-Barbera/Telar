/**
 * A PLUGIN'S SETTINGS, AS ROWS — the pure half of the generated pane.
 *
 * The engine publishes each plugin's settings as JSON Schema (`PluginStatus.
 * settingsSchema` / `machineSettingsSchema`, generated from the zod schema the
 * host validates writes against). This turns one into the fields a pane draws,
 * so any plugin gets a complete, working settings pane without a bespoke one.
 *
 * WHAT IT RENDERS: top-level properties that are a toggle (boolean), a select
 * (string enum), text (string), a path (string with `widget: "path"`) or a
 * number. WHAT IT SKIPS: nested objects and arrays — an environment list or a
 * toolchain choice is a bespoke block's job, registered beside the pane.
 *
 * Labels and hints come from the schema's `title` and `description`; `info` is
 * the fact behind the row's ⓘ; `inherits` names the Mac key a project falls
 * back to, which is what draws "Inherit (<Mac value>)". `labels` names a
 * select's choices for people, and `icon` is the row's glyph (a Lucide name).
 */
import type { PluginStatus } from "@telar/engine-client";
import { foldForSearch, settingsRowId, type SettingsSearchEntry } from "@/lib/settings-search";

type SettingsFieldKind = "toggle" | "select" | "text" | "path" | "number";

export type SettingsField = {
  key: string;
  kind: SettingsFieldKind;
  label: string;
  hint?: string;
  info?: string;
  /** A select's choices, and how each reads. */
  options?: readonly string[];
  optionLabels?: Readonly<Record<string, string>>;
  /** A Lucide icon name, kebab-case. */
  icon?: string;
  /** A number's bounds and whether it is whole. */
  min?: number;
  max?: number;
  integer?: boolean;
  /** What the schema says the value is when nobody set one. */
  defaultValue?: unknown;
  /** The machine key a project inherits when this field is unset. */
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

/** `optional()` and `nullable()` may wrap a property in `anyOf`; unwrap one level. */
function unwrap(property: JsonProperty): JsonProperty {
  if (!property.anyOf) return property;
  const concrete = property.anyOf.filter((option) => option.type !== "null");
  if (concrete.length !== 1) return property;
  const { anyOf: _anyOf, ...outer } = property;
  void _anyOf;
  return { ...concrete[0], ...outer };
}

/** "slowMs" → "Slow ms", for a property the plugin gave no title. */
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

/** The fields a pane draws for one schema, in declaration order. */
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

/**
 * A number field's typed text, as the value to store — `undefined` for an empty
 * box (unset), or the sentence saying why the schema refuses it, so the row can
 * say so instead of writing something the engine will reject.
 */
export function parseNumberField(field: SettingsField, text: string): { value: number | undefined } | { error: string } {
  if (text.trim() === "") return { value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: "Enter a number." };
  if (field.integer && !Number.isInteger(value)) return { error: "Enter a whole number." };
  if (field.min !== undefined && value < field.min) return { error: `At least ${field.min}.` };
  if (field.max !== undefined && value > field.max) return { error: `At most ${field.max}.` };
  return { value };
}

/** How a value reads in "Inherit (<value>)" and beside a default. */
export function describeValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

/**
 * THE GROUP HEADING A GENERATED PANE USES, stated once so the rendered rows and
 * their search entries derive the same anchor.
 */
export function generatedGroupTitle(status: PluginStatus, scope: "project" | "machine"): string {
  const section = status.meta.settings.find((entry) => entry.scope === scope);
  return section?.label ?? status.meta.name;
}

/**
 * GENERATED ROWS ARE SEARCHABLE — one entry per field, pointing at the anchor
 * the row renders (`settingsRowId` over the pane, the group heading and the
 * label). Built from the engine's answer at runtime, because the schemas are
 * the plugins' and arrive with them.
 */
export function pluginSettingsSearchEntries(
  plugins: readonly PluginStatus[],
  pages: Record<"project" | "machine", { id: string; label: string }>,
  /** A scope whose pane is bespoke draws no generated rows, so indexes none. */
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
