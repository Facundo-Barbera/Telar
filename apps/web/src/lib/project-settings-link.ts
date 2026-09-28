/**
 * WHERE A GEAR BESIDE A PROJECT GOES: Settings ▸ Projects, which reads
 * `?project=` and binds its rows to that project. One function rather than six
 * template literals, so the route has one place to move.
 */
export function projectSettingsHref(projectId: string): string {
  return `/settings?section=projects&project=${encodeURIComponent(projectId)}`;
}
