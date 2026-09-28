/**
 * WHO DECIDES WHETHER A PLUGIN'S TOOL IS A READ. The host does. Always.
 *
 * `PluginMeta.readTools` is a CLAIM — a manifest saying "these tools of mine
 * change nothing". It is useful: it is how a plugin author tells us what they
 * believe, and it is what a reviewer reads first. It is NOT AUTHORITY. If a
 * manifest could classify its own tools as reads, then `approval-required` —
 * whose whole rule is "auto-accept reads, park everything else" — would be a
 * mode any plugin could switch off by typing a list, and a plugin installed from
 * a folder could exempt itself from approval by declaring
 * `readTools: ["evil_rm_rf"]`.
 *
 * So the classification is an INTERSECTION:
 *
 *     effective reads = plugin's claim  ∩  the host's ratified table below
 *
 * A claim the host has not ratified is dropped, and the tool stays a
 * `tool_call` that parks. Fail-closed in both directions: an unknown plugin
 * ratifies nothing, and a plugin that forgets to claim a tool the host ratified
 * still does not get it (the claim is required too, so the manifest and the host
 * must AGREE — which is what makes a diff to either one reviewable).
 *
 * RATIFYING AN ENTRY BELOW IS A SECURITY DECISION and it belongs in a diff a
 * human reads. That is the entire mechanism, and it is deliberately boring.
 */
import type { PluginMeta } from "@telar/engine-client";

/**
 * The host's ratified read classifications, keyed by plugin id.
 *
 * TODAY'S TABLE REPRODUCES TODAY'S BEHAVIOUR EXACTLY, which is the only safe
 * thing a refactor may do to an approval posture. `driver.ts`'s
 * `TELAR_READ_TOOLS` currently classifies `ds_packages` and `ds_kernel` as
 * reads, so those two appear here and nothing else does.
 *
 * NOTE WHAT IS ABSENT. `latex_status`, `latex_log`, `latex_toolchain` and
 * `latex_packages` all look like reads, and arguably are — but they are not
 * classified as reads today, and quietly reclassifying four tools while moving
 * the code that classifies them would widen authority under cover of a
 * migration. If they should be reads, that is its own change, with its own
 * review, on a day when the diff is about nothing else.
 */
export const HOST_RATIFIED_READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "data-science": ["ds_packages", "ds_kernel"],
  latex: [],
  hello: [],
};

/**
 * The reads a plugin actually gets: its claim, narrowed by the host's table and
 * by its own namespace.
 *
 * THE NAMESPACE CHECK IS THE THIRD GUARD and it catches a different attack from
 * the intersection. Without it, a plugin owning the prefix `hello` could claim
 * `ds_kernel` — a name the host HAS ratified, just for somebody else — and the
 * intersection alone would let it through. A plugin may only be believed about
 * tools it could plausibly own.
 */
export function ratifiedReadTools(meta: PluginMeta): string[] {
  const ratified = HOST_RATIFIED_READ_TOOLS[meta.id] ?? [];
  return meta.readTools.filter(
    (tool) => ratified.includes(tool) && meta.toolPrefixes.some((prefix) => tool.startsWith(`${prefix}_`)),
  );
}

/**
 * Claims the host refused, for the startup log. Not an error: a plugin claiming
 * more than it is granted is a normal state (the author believes their tool is a
 * read and the host has not looked yet), and it must be VISIBLE rather than
 * silent — an author whose claim is being dropped should be able to find out why
 * without reading this file.
 */
export function unratifiedReadClaims(meta: PluginMeta): string[] {
  const granted = new Set(ratifiedReadTools(meta));
  return meta.readTools.filter((tool) => !granted.has(tool));
}

/** Every read classification the host will honour, across a set of plugins. */
export function ratifiedReadToolSet(metas: readonly PluginMeta[]): Set<string> {
  const all = new Set<string>();
  for (const meta of metas) for (const tool of ratifiedReadTools(meta)) all.add(tool);
  return all;
}
