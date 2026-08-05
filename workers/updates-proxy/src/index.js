// Gate on a static shared secret before proxying reads from the private R2
// bucket. electron-updater sends this as a custom request header (configured
// via autoUpdater.requestHeaders in apps/desktop/main.js); CI writes to the
// bucket directly with R2 API credentials, so this Worker is read-only.

// R2 reports the range it actually served as either {offset,length} or
// {suffix}; both have to become one absolute byte span for Content-Range.
function servedSpan(range, size) {
  if (range && typeof range.suffix === "number") {
    return [Math.max(0, size - range.suffix), size - 1];
  }
  const start = range?.offset ?? 0;
  const length = range?.length ?? size - start;
  return [start, start + length - 1];
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const key = request.headers.get("X-Telar-Update-Key");
    if (!key || key !== env.UPDATE_KEY) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const objectKey = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!objectKey) {
      return new Response("Not Found", { status: 404 });
    }

    // Range matters here: electron-updater's differential downloader asks for
    // just the changed blocks a .blockmap identifies. Answering 200-with-the-
    // whole-body makes it give up and re-fetch the entire zip every update.
    const wantsRange = request.method === "GET" && request.headers.has("range");

    let object;
    try {
      object = await env.TELAR_UPDATES.get(objectKey, wantsRange ? { range: request.headers } : undefined);
    } catch {
      // R2 throws rather than returning null on an unsatisfiable range.
      return new Response("Range Not Satisfiable", { status: 416 });
    }
    if (!object) {
      return new Response("Not Found", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "no-cache");
    headers.set("accept-ranges", "bytes");

    let status = 200;
    if (wantsRange && object.range) {
      const [start, end] = servedSpan(object.range, object.size);
      headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
      headers.set("content-length", String(end - start + 1));
      status = 206;
    } else {
      headers.set("content-length", String(object.size));
    }

    return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
  },
};
