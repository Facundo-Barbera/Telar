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

// --- Multi-range requests: the differential downloader -----------------------
//
// WHY THIS EXISTS (issue #317). electron-updater downloads only the blocks a
// .blockmap says changed, and it asks for all of them in ONE request —
// `Range: bytes=0-8191, 40960-57343, …` — expecting the `multipart/byteranges`
// reply RFC 9110 §14.6 defines. R2's `get` takes a SINGLE range, and handed a
// header it cannot satisfy it serves the whole object with 200. So every
// differential download died on `Content-Type "multipart/byteranges" is
// expected, but got "application/zip"` and fell back to re-fetching all 145 MB
// — on a stream where 11-12% of the archive changes per nightly.
//
// So a multi-range GET is answered here instead: one R2 range read per span,
// assembled into a multipart body as it streams.

const CRLF = "\r\n";

// Each span is one R2 read, and a Worker has a finite subrequest budget. Past
// this many the request falls through to the whole object — the 200 that
// electron-updater already knows how to survive, at the cost of a full
// download, rather than a partial 206 it would assemble into a corrupt file.
const MAX_RANGE_PARTS = 256;

// How many spans a Range header names, WITHOUT needing the object's size. This
// is the cheap test for "is this the differential downloader?", asked before
// spending a HEAD on finding out.
export function rangeSpecCount(header) {
  const match = /^bytes=(.*)$/i.exec((header ?? "").trim());
  if (!match) return 0;
  return match[1].split(",").filter((spec) => spec.trim() !== "").length;
}

/**
 * The spans a Range header actually asks for, clamped to the object.
 *
 * THREE OUTCOMES, and they are not the same thing:
 *   · `null` — the header is malformed. RFC 9110 says ignore it and serve the
 *     whole representation, NOT 416: a client that sent nonsense gets bytes it
 *     can use rather than an error it did not ask a question for.
 *   · `[]`   — every span is satisfiable by nothing (starts past the end, or
 *     `-0`). That is 416.
 *   · spans  — absolute, inclusive, in the order the client asked. The order is
 *     load-bearing: electron-updater maps the Nth part of the reply onto the
 *     Nth task of its download plan.
 */
export function parseByteRanges(header, size) {
  const match = /^bytes=(.*)$/i.exec((header ?? "").trim());
  if (!match) return null;
  const specs = match[1]
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
  if (specs.length === 0) return null;

  const parts = [];
  for (const spec of specs) {
    const bounds = /^(\d*)-(\d*)$/.exec(spec);
    if (!bounds) return null; // one unreadable span voids the whole header
    const [, first, last] = bounds;
    if (first === "") {
      // A suffix range: the LAST n bytes.
      if (last === "") return null;
      const suffix = Number(last);
      if (suffix === 0) continue;
      parts.push({ start: Math.max(0, size - suffix), end: size - 1 });
      continue;
    }
    const start = Number(first);
    if (start >= size) continue;
    const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
    if (end < start) continue;
    parts.push({ start, end });
  }
  return parts;
}

function partPreamble(boundary, contentType, part, size) {
  return `--${boundary}${CRLF}Content-Type: ${contentType}${CRLF}Content-Range: bytes ${part.start}-${part.end}/${size}${CRLF}${CRLF}`;
}

/**
 * The exact byte length of the multipart body, computed before a byte of it is
 * read. Worth the arithmetic: a streamed reply with no Content-Length gives
 * electron-updater nothing to measure progress against, and a WRONG one breaks
 * the response outright — which is why the test asserts this against the body
 * it actually produces.
 */
export function multipartByteLength(boundary, contentType, parts, size) {
  const encoder = new TextEncoder();
  let total = encoder.encode(`--${boundary}--${CRLF}`).byteLength;
  for (const part of parts) {
    total += encoder.encode(partPreamble(boundary, contentType, part, size)).byteLength;
    total += part.end - part.start + 1 + CRLF.length;
  }
  return total;
}

// One part per pull: the preamble, then that span's bytes straight off R2, then
// the CRLF that separates it from the next delimiter. Nothing is buffered — a
// differential download of a 145 MB archive must not become a 145 MB array.
function multipartBody(bucket, objectKey, parts, size, contentType, boundary) {
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream({
    async pull(controller) {
      if (next >= parts.length) {
        controller.enqueue(encoder.encode(`--${boundary}--${CRLF}`));
        controller.close();
        return;
      }
      const part = parts[next++];
      controller.enqueue(encoder.encode(partPreamble(boundary, contentType, part, size)));
      const slice = await bucket.get(objectKey, {
        range: { offset: part.start, length: part.end - part.start + 1 },
      });
      if (!slice?.body) {
        // The object was replaced or removed between the HEAD and this read.
        // Erroring truncates the response, which is the only honest answer
        // left: a short part would be assembled into a corrupt file.
        controller.error(new Error(`missing bytes ${part.start}-${part.end} of ${objectKey}`));
        return;
      }
      const reader = slice.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.enqueue(encoder.encode(CRLF));
    },
  });
}

/**
 * Answer a multi-span GET — or return `null` to mean "not something this path
 * will answer; use the ordinary single-range/whole-object response".
 */
export async function answerMultiRange(bucket, objectKey, rangeHeader) {
  const head = await bucket.head(objectKey);
  if (!head) return new Response("Not Found", { status: 404 });

  const parts = parseByteRanges(rangeHeader, head.size);
  if (parts === null) return null;
  if (parts.length === 0) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${head.size}` },
    });
  }
  if (parts.length > MAX_RANGE_PARTS) return null;

  const boundary = `telar-${crypto.randomUUID()}`;
  const contentType = head.httpMetadata?.contentType || "application/octet-stream";
  const headers = new Headers({
    // The object's own type moves INTO each part; the envelope's type is what
    // electron-updater checks before it will parse a reply at all.
    "content-type": `multipart/byteranges; boundary=${boundary}`,
    "content-length": String(multipartByteLength(boundary, contentType, parts, head.size)),
    etag: head.httpEtag,
    "cache-control": "no-cache",
    "accept-ranges": "bytes",
  });
  return new Response(multipartBody(bucket, objectKey, parts, head.size, contentType, boundary), {
    status: 206,
    headers,
  });
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
    if (wantsRange && rangeSpecCount(request.headers.get("range")) > 1) {
      const multipart = await answerMultiRange(env.TELAR_UPDATES, objectKey, request.headers.get("range"));
      if (multipart) return multipart;
    }

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
