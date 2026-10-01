import { LOCAL_HOST_ID, rewriteApiPath } from "@/platform/engine/host-client";

export function projectIconUrl(projectId: string, icon: string, hostId: string = LOCAL_HOST_ID): string {
  return rewriteApiPath(`/api/projects/${encodeURIComponent(projectId)}/icon?v=${encodeURIComponent(icon)}`, hostId);
}
