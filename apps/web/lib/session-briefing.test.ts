// "Start a session instead" — CAP-11's OTHER handoff (story 5.5).
//
// WHY THIS FILE EXISTS. CAP-11 names two handoffs and calls them equal weight:
// "a ripened packet becomes a loom's premise + context, or several selected
// items weave as one loom", and then "'Start a session instead' is an
// equal-weight alternative on both". The loom half shipped with three suites
// (workspace-handoff, detach-receipt, workspace-weave-route) and this half
// shipped with none — an equal-weight alternative tested unequally, which is how
// the cheaper half quietly becomes the fallback the spec forbids.
//
// TWO CLAIMS, and the second is the one that actually bit:
//   1. The briefing is the packet's OWN words. item-model.md: "At execution time
//      the packet IS the briefing — nothing is re-authored for handoff." So the
//      assertions below are on CONTENT (the brief text, the criteria, which
//      opener) rather than on shape, and one of them proves the moat sentence is
//      still in the trailer.
//   2. ONE PACKET PRODUCES ONE BRIEFING, whichever surface starts it. The queue
//      row and the packet page are two different call sites with two different
//      data shapes (getQueueView does not tally attachments per row), so the
//      same packet could — and at review time did — produce a briefing with the
//      attachment line from one button and without it from the other. That is a
//      claim about the SURFACES, so the last describe is a static scan; nothing
//      about testing this function can prove a third caller did not skip it.
//
// PURE, SO NO MOCKS. lib/session-briefing.ts imports one TYPE and nothing else,
// which is load-bearing: the packet view and the queue are "use client" and
// @telar/core is server-only (project-context.md's client-bundle rule). The bare
// import below is the proof — if the module ever reaches for a value from core,
// this file stops running rather than quietly passing.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { bullets, sessionBriefing, type BriefingPacket } from "./session-briefing";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

const packet = (over: Partial<BriefingPacket> = {}): BriefingPacket => ({
  id: "i-a1",
  title: "Accept payments-retry loom",
  ...over,
});

// The two sentences the composer authors about the handoff itself. Everything
// else in the output has to have come from the packet.
const RIPE_OPENER = "the brief below is the ripened one";
const RAW_OPENER = "it is still a raw capture, so the brief below is my own words";
const MOAT = "The packet stays in my queue while we work; closing it is mine to do, not yours.";

describe("the briefing is the packet's own words", () => {
  test("a ripened packet opens as ripened and carries `fixed` verbatim, criteria and all", () => {
    const out = sessionBriefing(
      packet({
        fixed: "Retry the payment webhook with exponential backoff, capped at 5 attempts.",
        acceptance: ["a 500 is retried", "a 400 is not retried"],
      }),
    );
    expect(out).toContain(RIPE_OPENER);
    expect(out).not.toContain(RAW_OPENER);
    // VERBATIM — not summarised, not re-worded, not truncated.
    expect(out).toContain("Retry the payment webhook with exponential backoff, capped at 5 attempts.");
    expect(out).toContain("## Accept payments-retry loom");
    expect(out).toContain("Acceptance criteria:\n- a 500 is retried\n- a 400 is not retried");
    // The trailer names the row the session must NOT close.
    expect(out).toContain("workspace item `i-a1`");
    expect(out.trimEnd().endsWith(MOAT)).toBe(true);
  });

  test("a raw capture says so, in the opener, and still hands over the human's own words", () => {
    // item-model.md keeps `raw` beside `fixed` precisely so a handoff can be
    // honest about which one it had. A briefing that presented an unripened
    // capture as a brief would be the one piece of re-authoring this module is
    // forbidden.
    const out = sessionBriefing(packet({ raw: "ask marta re: the retry thing?? maybe webhooks" }));
    expect(out).toContain(RAW_OPENER);
    expect(out).not.toContain(RIPE_OPENER);
    expect(out).toContain("ask marta re: the retry thing?? maybe webhooks");
  });

  test("`fixed` wins over `raw` when the packet has both — the ripened brief is the handoff", () => {
    const out = sessionBriefing(
      packet({ raw: "the shorthand nobody else can read", fixed: "The expert's written brief." }),
    );
    expect(out).toContain(RIPE_OPENER);
    expect(out).toContain("The expert's written brief.");
    expect(out).not.toContain("the shorthand nobody else can read");
  });

  test("a bare one-liner is a valid packet — no brief, nothing invented to fill the gap", () => {
    // CAP-5: "Richness is optional — a bare one-liner is a valid item."
    const out = sessionBriefing(packet({ title: "call the bank" }));
    expect(out).toContain("## call the bank");
    expect(out).toContain(RAW_OPENER);
    expect(out).not.toContain("Acceptance criteria:");
    expect(out).not.toContain("Sub-tasks already broken out:");
    // No placeholder body: the title, the trailer and the moat line, no filler.
    expect(out).not.toMatch(/\bTBD\b|no brief|not yet/i);
  });

  test("only the OPEN sub-tasks travel — a finished one is not work the session is being handed", () => {
    const out = sessionBriefing(
      packet({
        subtasks: [
          { id: "s1", title: "read the provider docs", done: true },
          { id: "s2", title: "write the backoff helper", done: false },
        ],
      }),
    );
    expect(out).toContain("Sub-tasks already broken out:\n- write the backoff helper");
    expect(out).not.toContain("read the provider docs");
  });

  test("attachments are NAMED as beside the packet, never claimed as attached", () => {
    // A composer draft cannot carry a file. Saying "2 files attached" would send
    // the session looking for an upload that never happened; saying where they
    // are is the honest version, and it is the same posture the loom half takes
    // in context.md.
    const two = sessionBriefing(packet({ attachments: { files: 2, mockups: 1 } }));
    expect(two).toContain("2 files + 1 mockup sit beside the packet in the workspace.");
    expect(two).not.toMatch(/attached/i);
    // Singular/plural on each half independently, and the VERB agrees with the
    // total rather than with the number of clauses ("1 file sit beside the
    // packet" is what counting clauses gets you).
    expect(sessionBriefing(packet({ attachments: { files: 1, mockups: 0 } }))).toContain(
      "1 file sits beside the packet",
    );
    expect(sessionBriefing(packet({ attachments: { files: 0, mockups: 1 } }))).toContain(
      "1 mockup sits beside the packet",
    );
    expect(sessionBriefing(packet({ attachments: { files: 0, mockups: 2 } }))).toContain(
      "2 mockups sit beside the packet",
    );
  });

  test("an empty tally adds NO line — the trailer is the item id alone", () => {
    // The zero case is the one that separates "the packet has none" from "this
    // surface did not look", and it is why the queue re-reads the packet before
    // it seeds (see the scan below).
    const none = sessionBriefing(packet({ attachments: { files: 0, mockups: 0 } }));
    expect(none).not.toContain("sit beside the packet");
    expect(none).toContain("workspace item `i-a1`");
    expect(none).not.toContain("·");
  });

  test("the moat is stated to the session, on every shape of packet", () => {
    // "No agent-initiated execution … no agent starts work, completes work, or
    // accepts" (SPEC.md non-goals). The session is told in its own first
    // message, because it is the one participant that could otherwise assume
    // finishing the work means closing the row.
    for (const p of [
      packet(),
      packet({ fixed: "brief", acceptance: ["a"], attachments: { files: 1, mockups: 0 } }),
      packet({ raw: "raw", subtasks: [{ id: "s", title: "t", done: false }] }),
    ]) {
      expect(sessionBriefing(p)).toContain(MOAT);
    }
  });

  test("bullets is the shared one-liner, and it is shared rather than re-spelled", () => {
    // lib/workspace-handoff.ts imports THIS one (the direction is forced: that
    // module pulls in server-only core, this one is rendered from a client
    // component). The pin is here so the import cannot be quietly replaced by a
    // second copy.
    expect(bullets(["a", "b"])).toBe("- a\n- b");
    expect(bullets([])).toBe("");
    expect(read("lib/workspace-handoff.ts")).toContain('from "@/lib/session-briefing"');
  });
});

// ── one packet, one briefing, however it was started ────────────────────────
//
// A DIRECTORY WALK rather than a hand-listed set, for the same reason
// detach-receipt.test.ts uses one: the failure mode is a surface that does not
// exist yet (5.3's master chat is the next one) composing its own opener or
// writing the composer's draft key by hand.

const SCAN_ROOTS = ["app", "components", "lib"];
const COMPOSER = "lib/session-briefing.ts";
// The two surfaces that hand a packet to a session today, in CAP-11's own
// pairing: the packet's own page and the queue's batch bar.
const SURFACES = [
  "components/workspace/packet-view.tsx",
  "components/workspace/queue-view.tsx",
];
// The module that owns the composer draft key and the seeding verb.
const DRAFT_OWNER = "components/session/composer-draft.tsx";

// Line comments first, then blocks — the order is load-bearing (a `/**` inside a
// `//` swallows real code), same note as workspace-ui-idiom.test.ts's.
const stripComments = (src: string) =>
  src.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

function sources(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(rel, WEB_ROOT), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        // demo-gallery is read-only design source (that directory's rule 7).
        if (entry.name === "demo-gallery" || entry.name === "node_modules") continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(child.slice(2));
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(`./${root}`);
  return out;
}

describe("one composer, two surfaces, one draft key", () => {
  test("no production module outside lib/session-briefing.ts writes the briefing's own words", () => {
    const files = sources();
    // ANTI-VACUITY: the walk really found the tree it claims to scan.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(COMPOSER);
    for (const surface of SURFACES) expect(files).toContain(surface);

    const offenders = files.filter(
      (f) => f !== COMPOSER && /Working this packet from my workspace queue/.test(stripComments(read(f))),
    );
    expect(offenders).toEqual([]);
    // …and the words really are in the file that is allowed to hold them, so the
    // filter above excluded something rather than matching nothing.
    expect(stripComments(read(COMPOSER))).toContain("Working this packet from my workspace queue");
  });

  test("BOTH surfaces pass an attachment tally — one packet cannot produce two different briefings", () => {
    // THE BUG THIS PINS. getQueueView deliberately does not tally attachments
    // per row (queue-view.tsx's own header says why), so seeding straight from
    // the row produced a briefing MISSING the "2 files sit beside the packet"
    // line that the same packet's page included. The queue therefore re-reads
    // the packet before it seeds; that extra GET is the whole reason its handler
    // is async, and it is what this asserts.
    for (const surface of SURFACES) {
      const src = stripComments(read(surface));
      expect(src).toContain("sessionBriefing(");
      expect(src).toMatch(/attachments:\s*view\.attachments/);
    }
    // The queue's half is the fetch, and it is a READ of the packet endpoint —
    // not a second tally computed from the row.
    expect(stripComments(read("components/workspace/queue-view.tsx"))).toContain(
      "/api/workspace/items/",
    );
  });

  test("nobody writes the composer's draft key by hand — the seeding verb is the only door", () => {
    // composer-draft.tsx owns the key AND the two behaviours a bare
    // localStorage.setItem cannot have: the confirm before replacing a human's
    // half-typed message, and the announcement that reaches an ALREADY-MOUNTED
    // composer (whose restore effect fires on key transitions only, so a
    // router.push into it would never read the seed).
    const files = sources();
    const spellers = files.filter(
      (f) => f !== DRAFT_OWNER && /telar:draft:new/.test(stripComments(read(f))),
    );
    expect(spellers).toEqual([]);
    expect(stripComments(read(DRAFT_OWNER))).toContain("telar:draft:new:");

    for (const surface of SURFACES) {
      const src = stripComments(read(surface));
      expect(src).toContain("seedNewSessionDraft(");
      // No surface writes storage directly — that is the shape the confirm and
      // the announcement would both be skipped by.
      expect(src).not.toContain("localStorage.setItem");
    }
  });

  test("the composer stays value-import-free, which is what lets a client component call it", () => {
    // @telar/core is server-only. A TYPE import erases; a value import from it
    // in this module would put the whole store in the browser bundle.
    const src = stripComments(read(COMPOSER));
    const imports = src.match(/^\s*import\s[^;]+;/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/^\s*import type /);
    expect(imports[0]).toContain("@telar/core");
  });
});
