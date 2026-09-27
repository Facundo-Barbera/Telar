import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { manifestFromFeed } from "./handoff-manifest.mjs";

const require = createRequire(import.meta.url);
const core = require("../apps/desktop/desktop-handoff-core.js");

const SHA = Buffer.alloc(64, 7).toString("base64");
// The shape electron-builder writes for a zip-only nightly.
const feed = (files) => `version: 0.2.0-nightly.20261001.1
files:
${files}
path: Telar-0.2.0-nightly.20261001.1-arm64-mac.zip
sha512: ${SHA}
releaseDate: '2026-10-01T00:00:00.000Z'
`;
const zip = `  - url: Telar-0.2.0-nightly.20261001.1-arm64-mac.zip
    sha512: ${SHA}
    size: 150000000`;

describe("the hand-off manifest comes from N's own feed", () => {
  test("version, zip, size and sha512 are the feed's; the id is always N's", () => {
    const manifest = manifestFromFeed(feed(zip), { channel: "nightly", team: "MM74W7WGAM" });
    expect(manifest).toEqual({
      version: "0.2.0-nightly.20261001.1",
      channel: "nightly",
      zip: "Telar-0.2.0-nightly.20261001.1-arm64-mac.zip",
      sha512: SHA,
      size: 150000000,
      bundleId: core.NEW_BUNDLE_ID,
      teamId: "MM74W7WGAM",
    });
    // What the old app will accept, checked by the old app's own validator.
    expect(core.validateManifest(manifest, { channel: "nightly" }).ok).toBe(true);
  });

  test("a feed with a dmg beside the zip still names the zip", () => {
    const dmg = `  - url: Telar-0.2.0-beta.1-arm64.dmg
    sha512: ${SHA}
    size: 160000000`;
    expect(manifestFromFeed(feed(`${zip}\n${dmg}`), { channel: "nightly", team: "MM74W7WGAM" }).zip).toEndWith(".zip");
  });

  test("no zip, or a manifest the old app would refuse, is an error here and not there", () => {
    expect(() => manifestFromFeed(feed("  []"), { channel: "nightly", team: "MM74W7WGAM" })).toThrow("0 zips");
    expect(() => manifestFromFeed(feed(zip), { channel: "nightly", team: "not-a-team" })).toThrow("teamId");
  });
});
