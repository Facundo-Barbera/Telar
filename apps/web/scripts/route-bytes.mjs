#!/usr/bin/env node
/**
 * HOW MUCH JAVASCRIPT A ROUTE SHIPS, read off a build rather than guessed (#492).
 *
 * WHY THIS FILE EXISTS. `next build` under Turbopack prints a route table with
 * no size column, so "a settings page ships the cockpit" had no number attached
 * to it and neither did any fix. The facts are all in the build output already —
 * this only adds them up.
 *
 * WHAT IS COUNTED. Every route's client boundary is described by
 * `server/app/<route>/page_client-reference-manifest.js`: one entry per client
 * module, each naming the chunks that module needs. The union of those chunks,
 * plus the root chunks every route loads (`page/build-manifest.json`), is the
 * JavaScript a browser fetches to render that route. A component behind
 * `next/dynamic` is NOT in that union — its chunk is fetched when the component
 * is first rendered — which is exactly the difference this issue is about.
 *
 * BYTES ARE THE FILES ON DISK, uncompressed, `.map` excluded. Uncompressed
 * because it is the number that tracks parse and execute cost, which is what a
 * cold settings page was paying; gzip would flatter every figure here by the
 * same factor and change no decision.
 *
 * Usage:  node scripts/route-bytes.mjs [distDir] [--json]
 *         node scripts/route-bytes.mjs .next-before
 *         node scripts/route-bytes.mjs .next --json > after.json
 */

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const distDir = args.find((arg) => !arg.startsWith("--")) ?? ".next";
const appDir = join(distDir, "server", "app");

if (!existsSync(appDir)) {
  console.error(`No build at ${appDir}. Run \`next build\` first.`);
  process.exit(1);
}

/** Every `page_client-reference-manifest.js` under server/app, as a route path. */
function findRoutes(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findRoutes(path));
    else if (entry.name === "page_client-reference-manifest.js") {
      const route = "/" + relative(appDir, dir).split("/").join("/");
      found.push({ route: route === "/." ? "/" : route, manifest: path });
    }
  }
  return found;
}

/**
 * The manifest is a script that assigns onto `globalThis.__RSC_MANIFEST`, not
 * JSON — evaluating it is how Next itself reads it, and parsing the assignment
 * by hand would break the first time the preamble changes.
 */
function readManifest(path) {
  const scope = { __RSC_MANIFEST: {} };
  new Function("globalThis", readFileSync(path, "utf8"))(scope);
  const entries = Object.values(scope.__RSC_MANIFEST);
  const chunks = new Set();
  for (const entry of entries) {
    for (const mod of Object.values(entry.clientModules ?? {})) {
      for (const chunk of mod.chunks ?? []) chunks.add(chunk);
    }
  }
  return chunks;
}

/** The chunks every route pays for: the root bundle and the polyfills. */
function rootChunks(routeDir) {
  const path = join(routeDir, "page", "build-manifest.json");
  if (!existsSync(path)) return [];
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];
}

/** `/​_next/static/chunks/x.js` and `static/chunks/x.js` both name one file. */
function bytesOf(chunk) {
  const rel = chunk.replace(/^\/_next\//, "").replace(/^\//, "");
  if (rel.endsWith(".map")) return 0;
  try {
    return statSync(join(distDir, rel)).size;
  } catch {
    return 0;
  }
}

const rows = [];
for (const { route, manifest } of findRoutes(appDir)) {
  const routeDir = join(appDir, route === "/" ? "." : route.slice(1));
  const chunks = readManifest(manifest);
  for (const chunk of rootChunks(routeDir)) chunks.add(chunk);
  let bytes = 0;
  for (const chunk of chunks) bytes += bytesOf(chunk);
  rows.push({ route, chunks: chunks.size, bytes });
}
rows.sort((a, b) => b.bytes - a.bytes);

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  const width = Math.max(...rows.map((row) => row.route.length), 5);
  console.log(`${"Route".padEnd(width)}  ${"JS".padStart(10)}  Chunks`);
  for (const row of rows) console.log(`${row.route.padEnd(width)}  ${kb(row.bytes).padStart(10)}  ${row.chunks}`);
}
