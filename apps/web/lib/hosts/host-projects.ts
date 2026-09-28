"use client";

/**
 * Project ids are only meaningful per engine, so the host travels with the list;
 * a listing for another host is dropped, never relabelled.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { PROJECTS_CHANGED_EVENT } from "@/lib/projects";
import { hostFetcher, hostFromPathname, LOCAL_HOST_ID } from "./client";

export type HostProjects = { hostId: string; projects: Project[] };

export function projectsForHost(listing: HostProjects | undefined, hostId: string): Project[] {
  return listing && listing.hostId === hostId ? listing.projects : [];
}

/**
 * Never the project's id: the same id can exist on two Macs. A resolved registry
 * that lacks the project means the wrong Mac, and the label says so.
 */
export function projectLabel(input: {
  name: string | undefined;
  /** What that Mac calls itself, when it's not this one. */
  hostName: string | undefined;
  resolved: boolean;
}): string {
  if (input.name) return input.name;
  if (!input.resolved) return "Loading…";
  return input.hostName ? `No such project on ${input.hostName}` : "No such project";
}

export type HostProjectsHandle = {
  /** `"local"` for this Mac. */
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
  /** Written from an effect; read only from callbacks. */
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

  // Cleared during render, not in an effect, so no frame shows one Mac's projects under another's address.
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
    // Deferred a tick: setting state in an effect body trips the lint rule.
    const task = window.setTimeout(reload, 0);
    // Same-window event from `lib/projects.ts`; no polling.
    window.addEventListener(PROJECTS_CHANGED_EVENT, reload);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, reload);
    };
  }, [reload]);

  return { hostId, projects: projectsForHost(listing, hostId), loading, reload };
}
