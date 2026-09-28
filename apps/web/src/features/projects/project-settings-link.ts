export function projectSettingsHref(projectId: string): string {
  return `/settings?section=projects&project=${encodeURIComponent(projectId)}`;
}
