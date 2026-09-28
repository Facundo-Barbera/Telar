import type { PluginMeta } from "@telar/engine-client";

export const HOST_RATIFIED_READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "data-science": ["ds_packages", "ds_kernel"],
  latex: [],
  hello: [],
};

export function ratifiedReadTools(meta: PluginMeta): string[] {
  const ratified = HOST_RATIFIED_READ_TOOLS[meta.id] ?? [];
  return meta.readTools.filter(
    (tool) => ratified.includes(tool) && meta.toolPrefixes.some((prefix) => tool.startsWith(`${prefix}_`)),
  );
}

export function unratifiedReadClaims(meta: PluginMeta): string[] {
  const granted = new Set(ratifiedReadTools(meta));
  return meta.readTools.filter((tool) => !granted.has(tool));
}

export function ratifiedReadToolSet(metas: readonly PluginMeta[]): Set<string> {
  const all = new Set<string>();
  for (const meta of metas) for (const tool of ratifiedReadTools(meta)) all.add(tool);
  return all;
}
