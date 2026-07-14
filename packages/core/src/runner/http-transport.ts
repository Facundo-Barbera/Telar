// M5 HTTP transport — the flag-on RunnerTransport over the runner's loopback
// control channel. Every call presents the bearer token from runner.json. The
// `fetchFn` is injected (default global fetch) so unit tests assert the
// verb→request mapping + token + error surfacing WITHOUT opening a socket.
import type { Loom } from "../looms";
import type { RunnerTransport, HealthInfo, StartFromBundleOpts } from "./transport";
import type { StartLoomInput } from "../dispatcher";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type HttpTransportConfig = {
  baseUrl: string; // e.g. http://127.0.0.1:53211
  token: string; // bearer from runner.json
  fetchFn?: FetchFn; // default global fetch; tests inject a fake
};

export function makeHttpTransport(cfg: HttpTransportConfig): RunnerTransport {
  const fetchFn = cfg.fetchFn ?? (fetch as FetchFn);
  const base = cfg.baseUrl.replace(/\/+$/, "");

  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      // Surface the runner's error text so the web route can 500 with a reason
      // rather than a silent undefined.
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* body already consumed / unavailable */
      }
      throw new Error(`runner ${method} ${path} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    // 204/empty → undefined; JSON otherwise.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  return {
    health: () => call<HealthInfo>("GET", "/health"),
    getActive: () => call<string[]>("GET", "/active"),
    start: (input: StartLoomInput) => call<Loom>("POST", "/dispatch/loom", { verb: "start", input }),
    startFromBundle: (loomId: string, by: string, opts?: StartFromBundleOpts) =>
      call<Loom>("POST", "/dispatch/loom", { verb: "startFromBundle", loomId, by, opts }),
    approveCharter: (id: string, by: string) =>
      call<boolean>("POST", "/dispatch/loom", { verb: "approveCharter", id, by }),
    steer: (id: string, directive: string, by: string) =>
      call<Loom>("POST", "/dispatch/loom", { verb: "steer", id, directive, by }),
    reject: (id: string, feedback: string, by: string) =>
      call<Loom>("POST", "/dispatch/loom", { verb: "reject", id, feedback, by }),
    resume: (id: string) => call<Loom>("POST", "/dispatch/loom", { verb: "resume", id }),
    cancel: (id: string) => call<boolean>("POST", "/stop/loom", { id }),
  };
}
