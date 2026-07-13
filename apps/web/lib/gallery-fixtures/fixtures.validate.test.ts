// GALLERY (delete with /gallery) — the anti-drift proof for the fixture
// registry. Every zod-backed NESTED structure in every bundle is parsed against
// the REAL @telar/core schemas, and the REAL validateContract() falsifiability
// invariant is run over every attached contract. If a fixture ever drifts from
// the production types, this test fails.
//
// HONEST GAP (requirement 4): Loom / LoomEvent / AttemptRecord / GateResult /
// RepairRound are PLAIN TS TYPES in @telar/core, not zod schemas — there is no
// `Loom.parse`. The fixture ENVELOPE is therefore compile-time-checked (the
// modules are typed Loom / LoomEvent and tsc gates the build); every zod-backed
// nested structure below is RUNTIME-validated here.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  assertProvenance,
  Charter,
  ContractAssertion,
  PanelReport,
  Provenance,
  ServersConfig,
  validateContract,
  Verdict,
  VerificationContract,
  VerifierReport,
  WorkUnitState,
} from "@telar/core";
import {
  GALLERY_FIXTURES,
  GALLERY_ID_PREFIX,
  getGalleryFixture,
  resolveGalleryFetch,
  type GalleryGroup,
} from "./index";

const ALL_GROUPS: GalleryGroup[] = [
  "journey",
  "scoping",
  "charter",
  "running",
  "blocked",
  "env",
  "verify",
  "review",
  "ready",
  "terminal",
  "drawers",
  "chat",
];

describe("GALLERY_FIXTURES registry integrity", () => {
  test("has one bundle per catalog entry (35) with unique ids", () => {
    expect(GALLERY_FIXTURES.length).toBe(35);
    const ids = GALLERY_FIXTURES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("(1) bundle.id === loom.id and carries the GALLERY_ID_PREFIX", () => {
    for (const b of GALLERY_FIXTURES) {
      expect(b.id).toBe(b.loom.id);
      expect(b.id.startsWith(GALLERY_ID_PREFIX)).toBe(true);
      expect(getGalleryFixture(b.id)).toBe(b);
    }
  });

  test("(10) every GalleryGroup is represented", () => {
    const groups = new Set(GALLERY_FIXTURES.map((b) => b.group));
    for (const g of ALL_GROUPS) expect(groups.has(g)).toBe(true);
    // No stray group outside the frozen union.
    for (const g of groups) expect(ALL_GROUPS).toContain(g);
  });
});

describe("every bundle parses through the REAL @telar/core schemas", () => {
  for (const b of GALLERY_FIXTURES) {
    test(`${b.id}`, () => {
      // (2) loom.state + every thread.state are valid WorkUnitStates.
      expect(() => WorkUnitState.parse(b.loom.state)).not.toThrow();
      for (const t of b.threads) expect(() => WorkUnitState.parse(t.state)).not.toThrow();

      // (8) every thread points back at the root loom.
      for (const t of b.threads) {
        if (t.parentLoomId !== undefined) expect(t.parentLoomId).toBe(b.loom.id);
      }

      // (3) charters (root + threads) parse against Charter.
      if (b.loom.charter) expect(() => Charter.parse(b.loom.charter)).not.toThrow();
      for (const t of b.threads) {
        if (t.charter) expect(() => Charter.parse(t.charter)).not.toThrow();
      }

      // (4) proposed servers.yaml parses against ServersConfig.
      if (b.loom.proposedServers) {
        expect(() => ServersConfig.parse(b.loom.proposedServers)).not.toThrow();
      }

      // (5) each attempt's zod-backed artifacts parse; humanJudged is subjective
      // live-critic (mirrors validateContract's §3.6 rule).
      const attempts = [b.loom, ...b.threads].flatMap((l) => l.attempts);
      for (const a of attempts) {
        if (a.verdict) expect(() => Verdict.parse(a.verdict)).not.toThrow();
        if (a.verifierReport) expect(() => VerifierReport.parse(a.verifierReport)).not.toThrow();
        if (a.panelReport) expect(() => PanelReport.parse(a.panelReport)).not.toThrow();
        for (const hj of a.humanJudged ?? []) {
          expect(() => ContractAssertion.parse(hj)).not.toThrow();
          expect(hj.subjective).toBe(true);
          expect(hj.type).toBe("live-critic");
        }
      }

      // (6) the spec contract parses AND satisfies the REAL falsifiability
      // invariant — validateContract must return NO violations.
      if (b.spec?.contract) {
        expect(() => VerificationContract.parse(b.spec!.contract)).not.toThrow();
        expect(validateContract(b.spec!.contract!)).toEqual([]);
      }

      // (7) spec provenance passes the real assertProvenance guard.
      if (b.spec?.provenance) {
        expect(() => assertProvenance(b.spec!.provenance)).not.toThrow();
        expect(() => Provenance.parse(b.spec!.provenance)).not.toThrow();
      }
    });
  }
});

describe("(9) resolveGalleryFetch round-trips per bundle", () => {
  const GET = (url: string) => resolveGalleryFetch({ url, method: "GET" });

  for (const b of GALLERY_FIXTURES) {
    test(`${b.id}`, () => {
      // Root + threads always json.
      expect(GET(`/api/looms/${b.id}`)).toMatchObject({ kind: "json", body: { loom: b.loom } });
      expect(GET(`/api/looms/${b.id}/threads`)).toMatchObject({ kind: "json", body: { threads: b.threads } });

      // /spec is json whether a bundle is attached (200) or not (404-shaped).
      const spec = GET(`/api/looms/${b.id}/spec`);
      expect(spec.kind).toBe("json");
      if (b.spec) expect(spec).toMatchObject({ kind: "json", body: b.spec });

      // /chat is json ({ chat: … | null }).
      const chat = GET(`/api/looms/${b.id}/chat`);
      expect(chat).toMatchObject({ kind: "json", body: { chat: b.chat ?? null } });

      // every evidence path resolves to an image data URI.
      for (const [relPath, dataUri] of Object.entries(b.evidence ?? {})) {
        expect(GET(`/api/looms/${b.id}/evidence/${relPath}`)).toEqual({ kind: "image", dataUri });
      }

      // any other sub-route is benign (never hits the real server).
      expect(GET(`/api/looms/${b.id}/events`)).toMatchObject({ kind: "json", body: { ok: false, gallery: true } });
      expect(
        resolveGalleryFetch({ url: `/api/looms/${b.id}/accept`, method: "POST" }),
      ).toMatchObject({ kind: "json", body: { ok: false, gallery: true } });
    });
  }

  test("real (non-fixture) loom urls pass through; /api/chat is benign", () => {
    expect(GET("/api/looms/loom_abc123_x9y8z7/spec")).toEqual({ kind: "passthrough" });
    expect(GET("/api/looms/loom_abc123_x9y8z7")).toEqual({ kind: "passthrough" });
    expect(GET("/api/accounts")).toEqual({ kind: "passthrough" });
    expect(GET("/api/models")).toEqual({ kind: "passthrough" });
    // absolute urls are handled the same (we slice from /api/).
    expect(GET("http://localhost:3000/api/looms/loom_real_1/threads")).toEqual({ kind: "passthrough" });
    // the SessionView chat runtime is always stubbed benign while mounted.
    expect(GET("/api/chat")).toMatchObject({ kind: "json", body: { ok: false, gallery: true } });
    expect(resolveGalleryFetch({ url: "/api/chat/sess_1/events", method: "GET" })).toMatchObject({
      kind: "json",
      body: { ok: false, gallery: true },
    });
    // an unknown gallery-shaped id is contained, never passed through.
    expect(GET(`/api/looms/${GALLERY_ID_PREFIX}nope/spec`)).toMatchObject({
      kind: "json",
      body: { ok: false, gallery: true },
    });
  });
});
