/**
 * WHERE A GEAR BESIDE A PROJECT GOES.
 *
 * It used to go to `/projects/:id/settings`, and that page is still there and
 * still right for what only it can hold: MCP servers scoped to the project, and
 * each plugin's own bespoke editor. What it is no longer the right destination
 * for is the QUESTION A GEAR ASKS — "what is this project called, what does it
 * look like, what do its conversations open on" — because every one of those now
 * lives on the Projects pane, which reads `?project=` and binds its rows to it.
 *
 * ONE FUNCTION RATHER THAN SIX TEMPLATE LITERALS, because six copies of a route
 * is six places to forget when it moves — and this route has now moved once.
 */
export function projectSettingsHref(projectId: string): string {
  return `/settings?section=projects&project=${encodeURIComponent(projectId)}`;
}
