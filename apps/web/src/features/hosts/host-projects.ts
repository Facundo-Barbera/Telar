"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { PROJECTS_CHANGED_EVENT } from "@/features/projects";
import { hostFetcher, hostFromPathname, LOCAL_HOST_ID } from "@/platform/engine/host-client";

export type HostProjects = { hostId: string; projects: Project[] };

export function projectsForHost(listing: HostProjects | undefined, hostId: string): Project[] {
  return listing && listing.hostId === hostId ? listing.projects : [];
}

export function projectLabel(input: {
  name: string | undefined;
  hostName: string | undefined;
  resolved: boolean;
}): string {
  if (input.name) return input.name;
  if (!input.resolved) return "Loading…";
  return input.hostName ? `No such project on ${input.hostName}` : "No such project";
}

export type HostProjectsHandle = {
  hostId: string;
  projects: Project[];
  loading: boolean;
  reload: () => void;
};

export function useHostProjects(): HostProjectsHandle {
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname ?? "/");
  const api = useMemo(() => createEngineApi(hostFetcher(hostId || LOCAL_HOST_ID)), [hostId]);

  const [listing, setListing] = useState<HostProjects>();
  const [loading, setLoading] = useState(true);
  const current = useRef(hostId);

  const reload = useCallback(() => {
    const asked = hostId;
    void api
      .projects()
      .then((result) => {
        if (current.current !== asked) return;
        setListing({ hostId: asked, projects: result.projects });
      })
      .catch(() => undefined)
      .finally(() => {
        if (current.current === asked) setLoading(false);
      });
  }, [api, hostId]);

  const [subject, setSubject] = useState(hostId);
  if (subject !== hostId) {
    setSubject(hostId);
    setListing(undefined);
    setLoading(true);
  }

  useEffect(() => {
    current.current = hostId;
  }, [hostId]);

  useEffect(() => {
    const task = window.setTimeout(reload, 0);
    window.addEventListener(PROJECTS_CHANGED_EVENT, reload);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, reload);
    };
  }, [reload]);

  return { hostId, projects: projectsForHost(listing, hostId), loading, reload };
}
