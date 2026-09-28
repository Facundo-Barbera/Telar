/** What a domain's client methods run on; `EngineClient` is the one implementation. */
export type EngineTransport = {
  request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal, operation?: string): Promise<T>;
};
