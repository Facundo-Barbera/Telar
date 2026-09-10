"use client";

/**
 * One Mac's project registry, with that Mac's identity attached.
 *
 * THE INVARIANT: a project id means nothing without the engine that minted it —
 * two Macs can hand out the same one — so the host travels WITH the list. The
 * read is pinned to one host, the answer is stored beside the host it came from,
 * and a listing whose host no longer matches is dropped rather than relabelled.
 * `lib/projects.ts` returns a bare `Project[]`, which is why this exists (see
 * docs/investigations/204-host-identity.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { PROJECTS_CHANGED_EVENT } from "@/lib/projects";
import { hostFetcher, hostFromPathname, LOCAL_HOST_ID } from "./client";

/** A registry read, and the Mac it describes. Inseparable on purpose. */
export type HostProjects = { hostId: string; projects: Project[] };

/** The list to show for `hostId`, or none: another Mac's listing is not stale
 *  data to relabel, it is data about something else. */
export function projectsForHost(listing: HostProjects | undefined, hostId: string): Project[] {
  return listing && listing.hostId === hostId ? listing.projects : [];
}

export type HostProjectsHandle = {
  /** The Mac this cockpit is looking at. `"local"` for this one. */
  hostId: string;
  /** Its projects, or empty until they have arrived for THIS host. */
  projects: Project[];
  /** True until this host has answered once. */
  loading: boolean;
  reload: () => void;
};

/** Read the current Mac's projects, keeping host and list together. The host
 *  comes from the address bar; which engine an ANSWER describes does not — that
 *  is fixed when the request is built and re-checked when it returns. */
export function useHostProjects(): HostProjectsHandle {
  const pathname = usePathname();
  const hostId = hostFromPathname(pathname ?? "/");
  const api = useMemo(() => createEngineApi(hostFetcher(hostId || LOCAL_HOST_ID)), [hostId]);

  const [listing, setListing] = useState<HostProjects>();
  const [loading, setLoading] = useState(true);
  /** The host in-flight reads are checked against. Written from an effect;
   *  read only from callbacks. */
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

  // A different Mac is a different registry: what is held describes the old one.
  // Cleared during render rather than from an effect so no frame lists one
  // Mac's projects under another's address.
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
    // Deferred a tick: setting state from an effect BODY is the cascade the lint
    // rule forbids, and an async callback is not the effect body.
    const task = window.setTimeout(reload, 0);
    // The registry changes when a person changes it, in this same app, so the
    // window event carries it here without a poll — same contract as
    // `lib/projects.ts`, whose event this is.
    window.addEventListener(PROJECTS_CHANGED_EVENT, reload);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, reload);
    };
  }, [reload]);

  return { hostId, projects: projectsForHost(listing, hostId), loading, reload };
}
