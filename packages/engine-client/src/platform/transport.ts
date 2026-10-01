export type Conditional<T> = { unchanged: true; etag?: string } | { unchanged: false; payload: T; etag?: string };

/** What a domain's client methods run on; `EngineClient` is the one implementation. */
export type EngineTransport = {
  request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal, operation?: string): Promise<T>;
  requestIfChanged<T>(pathname: string, etag?: string): Promise<Conditional<T>>;
  readBytes(pathAndQuery: string): Promise<{ data: Uint8Array; contentType: string }>;
};
