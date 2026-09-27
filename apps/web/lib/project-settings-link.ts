/**
 * WHERE A GEAR BESIDE A PROJECT GOES: Settings ▸ Projects, which reads
 * `?project=` and binds its rows to that project. The old per-project page
 * (`/projects/:id/settings`) is retired and redirects here (#363).
 *
 * ONE FUNCTION RATHER THAN SIX TEMPLATE LITERALS, because six copies of a route
 * is six places to forget when it moves — and this route has now moved once.
 */
export function projectSettingsHref(projectId: string): string {
  return `/settings?section=projects&project=${encodeURIComponent(projectId)}`;
}
