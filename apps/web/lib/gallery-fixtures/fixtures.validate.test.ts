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
  AccountProfile,
  assertProvenance,
  Charter,
  ContractAssertion,
  CriticFinding,
  CriticVerdict,
  McpServerConfig,
  PanelReport,
  ProjectManifest,
  Provenance,
  ServersConfig,
  validateContract,
  Verdict,
  VerificationContract,
  VerifierReport,
  WorkUnitState,
} from "@telar/core";
import {
  GALLERY_APP_VIEWS,
  GALLERY_COMPONENTS,
  GALLERY_FIXTURES,
  GALLERY_ID_PREFIX,
  getGalleryAppView,
  getGalleryComponent,
  getGalleryFixture,
  resolveGalleryAppFetch,
  resolveGalleryFetch,
  SHOWCASE,
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

// ===========================================================================
// GALLERY v2 — the anti-drift proof for the App views + Component showcase.
// Same discipline as above: every zod-backed shape parses against the REAL
// @telar/core schemas; the pure resolver round-trips; ids stay disjoint.
// ===========================================================================

describe("(v2) App-view + Component registry integrity", () => {
  test("every app + component id is unique and disjoint from the 35 loom ids", () => {
    const loomIds = new Set(GALLERY_FIXTURES.map((b) => b.id));
    const v2Ids = [
      ...GALLERY_APP_VIEWS.map((e) => e.id),
      ...GALLERY_COMPONENTS.map((e) => e.id),
    ];
    // unique among themselves
    expect(new Set(v2Ids).size).toBe(v2Ids.length);
    // disjoint from the frozen loom catalog
    for (const id of v2Ids) expect(loomIds.has(id)).toBe(false);
  });

  test("id prefixes + O(1) lookups", () => {
    for (const e of GALLERY_APP_VIEWS) {
      expect(e.id.startsWith("app-")).toBe(true);
      expect(getGalleryAppView(e.id)).toBe(e);
    }
    for (const e of GALLERY_COMPONENTS) {
      expect(e.id.startsWith("cmp-")).toBe(true);
      expect(getGalleryComponent(e.id)).toBe(e);
      expect(e.variants.length).toBeGreaterThan(0);
    }
  });

  test("the 35-loom catalog is untouched by the v2 additions", () => {
    expect(GALLERY_FIXTURES.length).toBe(35);
  });
});

describe("(v2) every app-view scene shape parses through the REAL schemas", () => {
  for (const entry of GALLERY_APP_VIEWS) {
    test(`${entry.id}`, () => {
      const scene = entry.scene;

      // Every /api/projects row's manifest parses via ProjectManifest (a null
      // manifest is the manifest-error case — skipped). mcpServers ride inside
      // the manifest parse; assert each server also parses on its own.
      for (const row of scene.projects?.body.projects ?? []) {
        if (row.manifest) {
          expect(() => ProjectManifest.parse(row.manifest)).not.toThrow();
          for (const cfg of Object.values(row.manifest.mcpServers)) {
            expect(() => McpServerConfig.parse(cfg)).not.toThrow();
          }
        } else {
          expect(typeof row.error).toBe("string");
        }
      }

      // Every account parses via AccountProfile, name matches the id charset.
      for (const acc of scene.accounts?.body.accounts ?? []) {
        expect(() => AccountProfile.parse(acc)).not.toThrow();
        expect(acc.name).toMatch(/^[A-Za-z0-9._-]+$/);
      }

      // Session seeds only exist on the three session views.
      if (entry.view.startsWith("session-")) {
        expect(entry.session).toBeDefined();
      }
    });
  }
});

describe("(v2) resolveGalleryAppFetch round-trips each scene endpoint", () => {
  const req = (url: string, method = "GET") => resolveGalleryAppFetch({ url, method }, null);

  test("null scene → passthrough for everything", () => {
    expect(req("/api/looms")).toEqual({ kind: "passthrough" });
    expect(req("/api/projects", "POST")).toEqual({ kind: "passthrough" });
  });

  test("each declared GET endpoint returns its body + status verbatim", () => {
    for (const entry of GALLERY_APP_VIEWS) {
      const s = entry.scene;
      const get = (url: string) => resolveGalleryAppFetch({ url, method: "GET" }, s);

      if (s.looms) {
        expect(get("/api/looms")).toMatchObject({ kind: "json", body: s.looms.body });
        if (s.looms.status) expect(get("/api/looms")).toMatchObject({ status: s.looms.status });
      }
      if (s.projects) expect(get("/api/projects")).toMatchObject({ kind: "json", body: s.projects.body });
      if (s.chats) {
        // query strings must not defeat the match.
        expect(get("/api/chats?project=finch&archived=0")).toMatchObject({ kind: "json", body: s.chats.body });
      }
      if (s.usage) expect(get("/api/usage")).toMatchObject({ kind: "json", body: s.usage.body });
      if (s.accounts) expect(get("/api/accounts")).toMatchObject({ kind: "json", body: s.accounts.body });
      if (s.mcpStatus) expect(get("/api/mcp/oauth/status?project=aurora")).toMatchObject({ kind: "json", body: s.mcpStatus.body });
      if (s.mcpTokens) expect(get("/api/projects/aurora/mcp")).toMatchObject({ kind: "json", body: s.mcpTokens.body });
      if (s.permissions) expect(get("/api/permissions/aurora")).toMatchObject({ kind: "json", body: s.permissions.body });
    }
  });

  test("status overrides drive empty (200) vs error (500) variants", () => {
    const err = getGalleryAppView("app-dashboard-error")!.scene;
    expect(resolveGalleryAppFetch({ url: "/api/looms", method: "GET" }, err)).toEqual({
      kind: "json",
      status: 500,
      body: err.looms!.body,
    });
    const empty = getGalleryAppView("app-projects-empty")!.scene;
    expect(resolveGalleryAppFetch({ url: "/api/projects", method: "GET" }, empty)).toEqual({
      kind: "json",
      body: { projects: [] },
    });
  });

  test("writes are benign { ok: true } by default; browse serves its scene body", () => {
    const s = getGalleryAppView("app-dashboard")!.scene;
    expect(resolveGalleryAppFetch({ url: "/api/looms", method: "POST" }, s)).toEqual({
      kind: "json",
      body: { ok: true },
    });
    expect(resolveGalleryAppFetch({ url: "/api/accounts", method: "PATCH" }, s)).toEqual({
      kind: "json",
      body: { ok: true },
    });
    // register-dialog's browse scene answers POST /api/browse.
    const reg = getGalleryComponent("cmp-register-dialog")!.scene!;
    expect(resolveGalleryAppFetch({ url: "/api/browse", method: "POST" }, reg)).toMatchObject({
      kind: "json",
      body: { path: expect.any(String) },
    });
  });

  test("an unhandled URL under a live scene passes through", () => {
    const s = getGalleryAppView("app-dashboard")!.scene;
    expect(resolveGalleryAppFetch({ url: "/api/models", method: "GET" }, s)).toEqual({ kind: "passthrough" });
  });
});

describe("(v2) SHOWCASE nested shapes parse through the REAL schemas", () => {
  test("gate rows carry the GateResult shape", () => {
    for (const g of Object.values(SHOWCASE.gate)) {
      expect(typeof g.name).toBe("string");
      expect(typeof g.ok).toBe("boolean");
      expect("exitCode" in g).toBe(true);
      expect(typeof g.output).toBe("string");
    }
  });

  test("critic verdicts + findings parse", () => {
    for (const key of ["pass", "blocking", "advisory"] as const) {
      expect(() => CriticVerdict.parse(SHOWCASE.critics[key])).not.toThrow();
    }
    expect(() => CriticFinding.parse(SHOWCASE.critics.finding)).not.toThrow();
    // the advisory lens is provably non-gating (blocker:false).
    expect(SHOWCASE.critics.advisory.blocker).toBe(false);
  });

  test("verifier reports parse (pass + fail)", () => {
    expect(() => VerifierReport.parse(SHOWCASE.verifierReport.pass)).not.toThrow();
    expect(() => VerifierReport.parse(SHOWCASE.verifierReport.fail)).not.toThrow();
  });

  test("the charter parses and carries a decomposition", () => {
    expect(() => Charter.parse(SHOWCASE.charter)).not.toThrow();
    expect(SHOWCASE.charter.decomposition.length).toBeGreaterThan(0);
  });

  test("the spec contract parses AND satisfies the falsifiability invariant", () => {
    expect(() => VerificationContract.parse(SHOWCASE.specContract)).not.toThrow();
    expect(validateContract(SHOWCASE.specContract)).toEqual([]);
  });

  test("attempts' zod-backed artifacts parse", () => {
    for (const a of Object.values(SHOWCASE.attempts)) {
      if (a.verdict) expect(() => Verdict.parse(a.verdict)).not.toThrow();
      if (a.panelReport) expect(() => PanelReport.parse(a.panelReport)).not.toThrow();
    }
  });

  test("the derived Plan + Operators reflect the real god-view derivation", () => {
    // s1 done, s2 running (from the mixed-state threads), s3 pending (no thread).
    const byId = Object.fromEntries(SHOWCASE.plan.nodes.map((n) => [n.id, n.state]));
    expect(byId.s1).toBe("done");
    expect(byId.s2).toBe("running");
    expect(byId.s3).toBe("pending");
    // the fan-out operator reconstructed its sub-agents from pieceId events.
    expect(SHOWCASE.operators.fanOut.subAgents.length).toBeGreaterThan(0);
    expect(SHOWCASE.operators.done.state).toBe("done");
    expect(SHOWCASE.operators.failed.error).toBeTruthy();
  });

  test("the project rows expose a healthy manifest + a manifest-error row", () => {
    expect(SHOWCASE.projectEntry.manifest).not.toBeNull();
    expect(() => ProjectManifest.parse(SHOWCASE.projectEntry.manifest)).not.toThrow();
    expect(SHOWCASE.manifestErrorEntry.manifest).toBeNull();
    expect(typeof SHOWCASE.manifestErrorEntry.error).toBe("string");
    for (const acc of SHOWCASE.accounts) {
      expect(() => AccountProfile.parse(acc)).not.toThrow();
    }
  });

  test("permission cards carry each status + narrow/broad rule options", () => {
    expect(SHOWCASE.permission.pending.status).toBe("pending");
    expect(SHOWCASE.permission.allowed.status).toBe("allowed");
    expect(SHOWCASE.permission.denied.status).toBe("denied");
    expect(SHOWCASE.permission.pending.ruleOptions.length).toBeGreaterThan(1);
  });
});
