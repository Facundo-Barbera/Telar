"use client";

import { useEffect, useRef, useState } from "react";
import type { DirectoryListing } from "@telar/engine-client";
import { directoryField, rememberedDirectoryKey } from "../directory-keys";
import { EngineApiError } from "@/platform/engine";

/** Must be stable across renders: it is a dependency of the fetching effect. */
export type DirectoryLister = (input: { path?: string; hidden?: boolean; nearest?: boolean }) => Promise<DirectoryListing>;

function remembered(hostId: string | undefined): string | undefined {
  try {
    return window.localStorage.getItem(rememberedDirectoryKey(hostId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(hostId: string | undefined, path: string): void {
  try {
    window.localStorage.setItem(rememberedDirectoryKey(hostId), path);
  } catch {
    return;
  }
}

export function useDirectoryListing({ list, hostId, startAt }: { list: DirectoryLister; hostId?: string | undefined; startAt?: string | undefined }) {
  const [target, setTarget] = useState<string | undefined>(() =>
    startAt ?? (typeof window === "undefined" ? undefined : remembered(hostId)),
  );
  const [nearest, setNearest] = useState(Boolean(startAt));
  const [aside, setAside] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  const [field, setField] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  // A remembered directory that has gone falls back to home, once.
  const fellBack = useRef(false);

  // No synchronous setState here; whatever changes the target turns the spinner on.
  useEffect(() => {
    let live = true;
    void list({ ...(target ? { path: target } : {}), ...(hidden ? { hidden: true } : {}), ...(nearest && target ? { nearest: true } : {}) })
      .then((answer) => {
        if (!live) return;
        if (answer.missing) setAside(`Nothing to open at ${answer.missing}, so this is the nearest folder that exists.`);
        setListing(answer);
        setField(directoryField(answer.path, answer.home));
        setIndex(0);
        setError(undefined);
        setUnreachable(false);
        setLoading(false);
        remember(hostId, answer.path);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setLoading(false);
        const code = cause instanceof EngineApiError ? cause.code : undefined;
        if (target && !fellBack.current && (code === "not_found" || code === "invalid_request")) {
          fellBack.current = true;
          if (nearest && cause instanceof EngineApiError) setAside(`${cause.message} Showing home instead.`);
          setNearest(false);
          setLoading(true);
          setTarget(undefined);
          return;
        }
        setUnreachable(code === "engine_unavailable" || code === "cockpit_unauthorized");
        setError(cause instanceof EngineApiError ? cause.message : "That folder could not be listed.");
      });
    return () => {
      live = false;
    };
  }, [list, target, hidden, nearest, hostId]);

  const open = (path: string) => {
    setError(undefined);
    setAside(undefined);
    setNearest(false);
    setLoading(true);
    setTarget(path);
  };

  const showHidden = (next: boolean) => {
    setLoading(true);
    setHidden(next);
  };

  const editField = (next: string) => {
    setField(next);
    setError(undefined);
  };

  return { listing, field, setField, editField, index, setIndex, hidden, showHidden, open, error, unreachable, loading, aside };
}
