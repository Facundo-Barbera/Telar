// WHAT THE UPDATE PROXY PROMISES A DIFFERENTIAL DOWNLOADER (issue #317).
//
// The bug these pin was invisible from the proxy's side: single-range GETs
// answered 206 in 0.2 s, a 20 MB range streamed at 9 MB/s, and every nightly
// still re-downloaded 145 MB — because the ONE request shape electron-updater
// uses for a differential update, several spans in a single Range header, came
// back 200 with the whole object. So the assertions here are about the envelope
// as much as the bytes: status, Content-Type, the boundary, and each part's own
// Content-Range.
//
// A fake `env.TELAR_UPDATES` rather than miniflare: R2's range semantics are
// mocked in ten lines, and what needs testing is this Worker's assembly, not
// Cloudflare's storage.

import test from "node:test";
import assert from "node:assert/strict";
import worker, { multipartByteLength, parseByteRanges, rangeSpecCount } from "./src/index.js";

const KEY = "shared-secret";
const OBJECT = "nightly/Telar-0.1.0-arm64-mac.zip";

// Recognisable, position-dependent bytes: every assertion about a span can be
// made against the span's own contents rather than a length.
const body = new Uint8Array(4096).map((_, index) => index % 251);

function bucket({ size = body.byteLength, contentType = "application/zip", missing = false } = {}) {
  const calls = [];
  const metadata = { size, httpEtag: '"etag-1"', httpMetadata: { contentType } };
  return {
    calls,
    async head(key) {
      calls.push({ op: "head", key });
      return missing || key !== OBJECT ? null : metadata;
    },
    async get(key, options) {
      calls.push({ op: "get", key, range: options?.range });
      if (missing || key !== OBJECT) return null;
      const range = options?.range;
      // A Headers instance is the single-range path handing R2 the request's
      // own header, which R2 parses itself. Anything it cannot satisfy throws,
      // exactly as the real binding does.
      if (range instanceof Headers) {
        const spec = /^bytes=(\d*)-(\d*)$/i.exec((range.get("range") ?? "").trim());
        if (!spec) return { ...metadata, body: stream(body), writeHttpMetadata: writeMeta(contentType) };
        const start = Number(spec[1]);
        if (start >= size) throw new Error("range not satisfiable");
        const end = spec[2] === "" ? size - 1 : Math.min(Number(spec[2]), size - 1);
        return {
          ...metadata,
          range: { offset: start, length: end - start + 1 },
          body: stream(body.subarray(start, end + 1)),
          writeHttpMetadata: writeMeta(contentType),
        };
      }
      if (!range) return { ...metadata, body: stream(body), writeHttpMetadata: writeMeta(contentType) };
      return {
        ...metadata,
        range,
        body: stream(body.subarray(range.offset, range.offset + range.length)),
        writeHttpMetadata: writeMeta(contentType),
      };
    },
  };
}

const writeMeta = (contentType) => (headers) => headers.set("content-type", contentType);
// Two chunks, deliberately: the assembler has to drain a part's stream rather
// than assume one read returns all of it.
const stream = (bytes) =>
  new ReadableStream({
    start(controller) {
      const half = Math.ceil(bytes.byteLength / 2);
      if (bytes.byteLength) controller.enqueue(bytes.subarray(0, half));
      if (bytes.byteLength > half) controller.enqueue(bytes.subarray(half));
      controller.close();
    },
  });

const get = (range) =>
  new Request(`https://updates.telar.test/${OBJECT}`, {
    headers: { "X-Telar-Update-Key": KEY, ...(range ? { range } : {}) },
  });

const call = (request, options) => worker.fetch(request, { UPDATE_KEY: KEY, TELAR_UPDATES: bucket(options) });

test("the shared secret is checked before the bucket is touched", async () => {
  const store = bucket();
  const env = { UPDATE_KEY: KEY, TELAR_UPDATES: store };
  const anonymous = new Request(`https://updates.telar.test/${OBJECT}`);
  assert.equal((await worker.fetch(anonymous, env)).status, 403);
  assert.deepEqual(store.calls, []);
  assert.equal((await worker.fetch(new Request(`https://updates.telar.test/${OBJECT}`, { method: "POST" }), env)).status, 405);
});

test("a whole-object GET is unchanged: 200, the object's own type, its length", async () => {
  const response = await call(get());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("content-length"), String(body.byteLength));
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
});

test("a single-range GET is unchanged: 206, one Content-Range, just those bytes", async () => {
  const response = await call(get("bytes=100-199"));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 100-199/${body.byteLength}`);
  assert.equal(response.headers.get("content-length"), "100");
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body.subarray(100, 200));
});

test("several spans in one header answer multipart/byteranges, in the order asked", async () => {
  const spans = [
    [0, 63],
    [1000, 1999],
    [4000, 4095],
  ];
  const response = await call(get(`bytes=${spans.map(([a, b]) => `${a}-${b}`).join(", ")}`));

  assert.equal(response.status, 206);
  const type = response.headers.get("content-type") ?? "";
  // The one thing the old response got wrong, and the reason every differential
  // download fell back: electron-updater refuses to parse a reply whose type is
  // not this.
  assert.match(type, /^multipart\/byteranges; boundary=telar-[0-9a-f-]+$/);
  const boundary = /boundary=(.+)$/.exec(type)[1];
  // A multipart envelope must not also claim a single span.
  assert.equal(response.headers.get("content-range"), null);

  const raw = new Uint8Array(await response.arrayBuffer());
  // A Content-Length that disagrees with the body by one byte breaks the
  // response, so it is asserted against the bytes actually produced.
  assert.equal(response.headers.get("content-length"), String(raw.byteLength));
  assert.equal(
    raw.byteLength,
    multipartByteLength(boundary, "application/zip", spans.map(([start, end]) => ({ start, end })), body.byteLength),
  );

  const text = Buffer.from(raw).toString("latin1");
  assert.equal(text.startsWith(`--${boundary}\r\n`), true);
  assert.equal(text.endsWith(`\r\n--${boundary}--\r\n`), true);
  assert.equal(text.split(`--${boundary}`).length - 1, spans.length + 1); // N delimiters + the close

  for (const [start, end] of spans) {
    assert.match(text, new RegExp(`Content-Range: bytes ${start}-${end}/${body.byteLength}\r\n`));
    // Each part carries the OBJECT's type, not the envelope's.
    const at = text.indexOf(`Content-Range: bytes ${start}-${end}/${body.byteLength}\r\n\r\n`);
    assert.notEqual(at, -1);
    const offset = at + `Content-Range: bytes ${start}-${end}/${body.byteLength}\r\n\r\n`.length;
    assert.deepEqual(raw.subarray(offset, offset + (end - start + 1)), body.subarray(start, end + 1));
  }
  assert.equal(text.split("Content-Type: application/zip\r\n").length - 1, spans.length);
});

test("a multi-span reply reads each span from R2 separately, after one HEAD", async () => {
  const store = bucket();
  await (await worker.fetch(get("bytes=0-9, 20-29"), { UPDATE_KEY: KEY, TELAR_UPDATES: store })).arrayBuffer();
  assert.deepEqual(store.calls, [
    { op: "head", key: OBJECT },
    { op: "get", key: OBJECT, range: { offset: 0, length: 10 } },
    { op: "get", key: OBJECT, range: { offset: 20, length: 10 } },
  ]);
});

test("spans are clamped to the object, and open/suffix forms are honoured", async () => {
  const response = await call(get(`bytes=4090-999999, -8`));
  assert.equal(response.status, 206);
  const text = Buffer.from(new Uint8Array(await response.arrayBuffer())).toString("latin1");
  assert.match(text, /Content-Range: bytes 4090-4095\/4096\r\n/);
  assert.match(text, /Content-Range: bytes 4088-4095\/4096\r\n/);
});

test("a range no byte can satisfy is 416, single-span and multi-span alike", async () => {
  assert.equal((await call(get("bytes=99999-100000"))).status, 416);
  const multi = await call(get("bytes=99999-100000, 200000-200001"));
  assert.equal(multi.status, 416);
  assert.equal(multi.headers.get("content-range"), `bytes */${body.byteLength}`);
});

test("a missing object is 404 on both paths, never an empty 206", async () => {
  assert.equal((await call(get(), { missing: true })).status, 404);
  assert.equal((await call(get("bytes=0-9, 20-29"), { missing: true })).status, 404);
});

test("a malformed multi-span header is ignored rather than answered 416", async () => {
  // RFC 9110: an unreadable Range is served as the whole representation. The
  // client asked a question badly; it gets bytes it can use, not an error.
  const response = await call(get("bytes=abc-def, 10-20"));
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
});

test("rangeSpecCount tells a differential request from an ordinary one without a HEAD", () => {
  assert.equal(rangeSpecCount(null), 0);
  assert.equal(rangeSpecCount("items=0-1"), 0);
  assert.equal(rangeSpecCount("bytes=0-1"), 1);
  assert.equal(rangeSpecCount("bytes=0-1, 4-5 , 9-"), 3);
  // A trailing comma is legal syntax for one span, not two.
  assert.equal(rangeSpecCount("bytes=0-1,"), 1);
});

test("parseByteRanges separates 'nonsense' from 'nothing to serve'", () => {
  assert.equal(parseByteRanges("chapters=1-2", 100), null);
  assert.equal(parseByteRanges("bytes=1-2-3", 100), null);
  assert.equal(parseByteRanges("bytes=-", 100), null);
  assert.deepEqual(parseByteRanges("bytes=200-300", 100), []);
  assert.deepEqual(parseByteRanges("bytes=-0", 100), []);
  assert.deepEqual(parseByteRanges("bytes=10-20, 50-", 100), [
    { start: 10, end: 20 },
    { start: 50, end: 99 },
  ]);
  // A backwards span is unsatisfiable on its own and does not void its
  // neighbours.
  assert.deepEqual(parseByteRanges("bytes=30-20, 0-9", 100), [{ start: 0, end: 9 }]);
});

test("more spans than the subrequest budget allows falls back to the whole object", async () => {
  // 257 spans: one R2 read each would outrun a Worker's subrequest budget, and
  // a truncated 206 would be assembled into a corrupt file. A 200 is a full
  // download — slow, and correct.
  const many = Array.from({ length: 257 }, (_, index) => `${index * 2}-${index * 2 + 1}`).join(", ");
  const response = await call(get(`bytes=${many}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
});
