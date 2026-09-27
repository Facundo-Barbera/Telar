#!/usr/bin/env bun
// THE HAND-OFF MANIFEST, derived from N's own update feed (#1042).
//
//   bun scripts/handoff-manifest.mjs --feed nightly-mac.yml --channel nightly --team MM74W7WGAM
//
// Prints handoff-<channel>-mac.json: which zip the old-id app downloads, and the
// size and sha512 it must match. Uploading it under the io.github.novarix.telar/
// prefix is what switches the hand-off on for that channel, so it is a separate,
// deliberate step and never part of a build.
import { createRequire } from "node:module";
import fs from "node:fs";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const core = require("../apps/desktop/desktop-handoff-core.js");

export function manifestFromFeed(feedText, { channel, team }) {
  const feed = Bun.YAML.parse(feedText);
  const zips = (feed?.files ?? []).filter((file) => typeof file?.url === "string" && file.url.endsWith(".zip"));
  if (zips.length !== 1) throw new Error(`the feed lists ${zips.length} zips, expected 1`);
  const checked = core.validateManifest(
    {
      version: feed.version,
      channel,
      zip: zips[0].url,
      sha512: zips[0].sha512,
      size: zips[0].size,
      bundleId: core.NEW_BUNDLE_ID,
      teamId: team,
    },
    { channel },
  );
  if (!checked.ok) throw new Error(checked.error);
  return checked.manifest;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { feed: { type: "string" }, channel: { type: "string" }, team: { type: "string" } } });
  if (!values.feed || !core.CHANNELS.includes(values.channel) || !values.team) {
    console.error("usage: handoff-manifest.mjs --feed <channel>-mac.yml --channel beta|nightly --team <TEAMID>");
    process.exit(2);
  }
  const manifest = manifestFromFeed(fs.readFileSync(values.feed, "utf8"), { channel: values.channel, team: values.team });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
