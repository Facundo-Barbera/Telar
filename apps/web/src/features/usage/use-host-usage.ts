"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicHost, UsageReport, UsageResolution } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import type { HostUsage } from "./hosts";

const THIS_COMPUTER = "This computer";

type Query = { key: string; ms: number; resolution: UsageResolution };

const localApi = createEngineApi(hostFetcher(LOCAL_HOST_ID));

function failure(cause: unknown, name: string): string {
  return cause instanceof Error && cause.message ? cause.message : `${name} did not answer.`;
}

export function useHostUsage(query: Query): { hosts: HostUsage[]; loading: boolean; reload: () => void } {
  const [hosts, setHosts] = useState<HostUsage[]>([{ hostId: LOCAL_HOST_ID, name: THIS_COMPUTER, loading: true }]);
  // Stale-while-revalidate per window and host: the engine's transcript rescan must never gate a button press.
  const cache = useRef(new Map<string, UsageReport>());
  const book = useRef<Promise<PublicHost[]>>(undefined);
  const request = useRef(0);

  const reload = useCallback(() => {
    const generation = ++request.current;
    book.current ??= localApi.hosts().then((answer) => answer.hosts, () => []);
    const untilMs = Date.now();
    const input = { sinceMs: untilMs - query.ms, untilMs, resolution: query.resolution, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const cacheKey = (hostId: string) => `${query.key}\0${hostId}`;
    const update = (hostId: string, patch: Partial<HostUsage>) => {
      if (generation !== request.current) return;
      setHosts((current) => current.map((host) => (host.hostId === hostId ? { ...host, ...patch } : host)));
    };
    const fetchOne = (host: { id: string; name: string }) => {
      createEngineApi(hostFetcher(host.id))
        .usage(input)
        .then(({ usage }) => {
          const previous = cache.current.get(cacheKey(host.id));
          if (!previous || usage.readAt >= previous.readAt) cache.current.set(cacheKey(host.id), usage);
          update(host.id, { report: usage, error: undefined, loading: false });
        })
        .catch((cause: unknown) => update(host.id, { error: failure(cause, host.name), loading: false }));
    };
    const entry = (id: string, name: string): HostUsage => {
      const cached = cache.current.get(cacheKey(id));
      return { hostId: id, name, loading: true, ...(cached ? { report: cached } : {}) };
    };

    setHosts((current) => current.map((host) => entry(host.hostId, host.name)));
    fetchOne({ id: LOCAL_HOST_ID, name: THIS_COMPUTER });
    void book.current.then((paired) => {
      if (generation !== request.current) return;
      setHosts((current) => [
        current.find((host) => host.hostId === LOCAL_HOST_ID) ?? entry(LOCAL_HOST_ID, THIS_COMPUTER),
        ...paired.map((host) => current.find((known) => known.hostId === host.id) ?? entry(host.id, host.name)),
      ]);
      for (const host of paired) fetchOne(host);
    });
  }, [query.key, query.ms, query.resolution]);

  useEffect(() => {
    const task = window.setTimeout(reload, 0);
    return () => {
      window.clearTimeout(task);
      request.current += 1;
    };
  }, [reload]);

  return { hosts, loading: hosts.some((host) => host.loading), reload };
}
