import type { EngineTransport } from "@telar/engine-client";
import type {
EngineErrorCode
} from "@telar/engine-client";
import { hostName, HOST_NAME_HEADER, LOCAL_HOST_ID, pinnedHost } from "@/platform/engine/host-client";

export type EngineApiErrorCode = EngineErrorCode | "cockpit_unauthorized";

/** WHICH MAC AN ANSWER CAME FROM. `id` is this cockpit's own id for it (the one
 *  in the URL); `name` is what that Mac calls itself, when it has said. */
export type ErrorHost = { id: string; name?: string };

export class EngineApiError extends Error {
  constructor(
    readonly code: EngineApiErrorCode,
    message: string,
    readonly status?: number,
    readonly host?: ErrorHost,
  ) {
    super(message);
    this.name = "EngineApiError";
  }
}

/** The Mac to name in a failure, or nothing when this one answered. The UI
 *  shows the name when the Mac has given one, and falls back to the id rather
 *  than to silence — an id at least distinguishes two paired Macs. */
export function refusedBy(error: EngineApiError): string | undefined {
  if (!error.host || error.host.id === LOCAL_HOST_ID) return undefined;
  return error.host.name ?? error.host.id;
}

export type Fetcher = typeof fetch;

/** What the request reached, as opposed to what it meant to reach: the pin on
 *  the fetcher, corrected by the name the proxy stamped on the way back. */
export function answeringHost(fetcher: Fetcher, response?: Response): ErrorHost | undefined {
  const id = pinnedHost(fetcher);
  if (!id || id === LOCAL_HOST_ID) return undefined;
  const name = response?.headers.get(HOST_NAME_HEADER) ?? hostName(id);
  return name ? { id, name } : { id };
}

export const READ_BUDGET = 2;

export const OPEN_BUDGET = 1;

function gate(budget: number) {
  let live = 0;
  const queued: Array<() => void> = [];
  return {
    /** Take a slot, waiting in line when the budget is spent. */
    async take(): Promise<void> {
      if (live < budget) {
        live += 1;
        return;
      }
      await new Promise<void>((resolve) => queued.push(resolve));
    },
    give(): void {
      const next = queued.shift();
      if (next) {
        next();
        return;
      }
      live -= 1;
    },
  };
}

export type Gate = ReturnType<typeof gate>;

export const reads = gate(READ_BUDGET);

/** The opening's own slot. Exported for the cockpit's sake only in the sense
 *  that `sessionBootstrap` below is the single caller — nothing else may take
 *  it, or it stops being the thing that makes an opening never wait. */
export const opens = gate(OPEN_BUDGET);

export async function request<T>(
  fetcher: Fetcher,
  method: string,
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
  lane: Gate = reads,
): Promise<T> {
  const budgeted = method === "GET" && signal === undefined;
  if (budgeted) await lane.take();
  try {
    return await send<T>(fetcher, method, pathname, body, signal);
  } finally {
    if (budgeted) lane.give();
  }
}

async function send<T>(fetcher: Fetcher, method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(pathname, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    // An abort is the CALLER's decision arriving back, not the adapter being
    // away — it must surface as itself so the UI can say "Stopped".
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    // A remote hop that throws here never reached this cockpit's proxy, so the
    // sentence about a "local adapter" would name the wrong machine.
    const host = answeringHost(fetcher);
    throw new EngineApiError(
      "engine_unavailable",
      host ? `The cockpit cannot reach ${host.name ?? "that Mac"}.` : "The cockpit cannot reach its local adapter.",
      undefined,
      host,
    );
  }

  const host = answeringHost(fetcher, response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngineApiError("engine_unavailable", "The engine adapter returned an invalid response.", response.status, host);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: EngineApiErrorCode; message?: string } } | null)?.error;
    throw new EngineApiError(error?.code ?? "internal_error", error?.message ?? "The engine request failed.", response.status, host);
  }
  return payload as T;
}

/** Runs the package's per-domain methods through this cockpit's `/api` proxy. */
export function apiTransport(fetcher: Fetcher): EngineTransport {
  const apiPath = (pathname: string) => pathname.replace(/^\/v2\//, "/api/");
  return {
    request: (method, pathname, body, signal) => request(fetcher, method, apiPath(pathname), body, signal),
    async readBytes(pathAndQuery) {
      const response = await fetcher(apiPath(pathAndQuery));
      if (!response.ok) throw new EngineApiError("engine_unavailable", "The engine request failed.", response.status, answeringHost(fetcher, response));
      return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" };
    },
  };
}
