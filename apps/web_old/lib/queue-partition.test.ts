// THE PENDING STRIP'S MEMBERSHIP RULE (feel contract rules 5-12) — successor
// to issue #31's three-bucket partition. The buckets are GONE by design: a
// message is your next message waiting (pending, editable), or the transcript
// owns it (claimed/running — the feed subscriber streams the drained turn, so
// the strip showing it too would be the duplicate #31 was about), or it did
// not send (pending with one plain error sentence and Retry/Discard on the
// line). No lifecycle vocabulary can render, by construction: pendingView
// never returns a state word, and the strip has nothing to print one from.
//
// Kept out of `message-queue.test.ts` deliberately: that file is about the
// order of sacrifice under a byte budget, a different policy with a different
// reason to change.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { QueueItemKind, QueueItemLifecycle } from "./message-queue";
import {
  isTerminalQueueState,
  isUserQueueItem,
  pendingView,
  plainQueueError,
} from "./message-queue";

const WEB_ROOT = new URL("../", import.meta.url);
const sessionView = () =>
  readFileSync(new URL("components/session/session-view.tsx", WEB_ROOT), "utf8");
const dock = () => readFileSync(new URL("components/dock/dock.tsx", WEB_ROOT), "utf8");

type Item = {
  id: string;
  state?: QueueItemLifecycle;
  accepted?: boolean;
  error?: string;
  kind?: QueueItemKind;
  hidden?: boolean;
};
const item = (id: string, state?: QueueItemLifecycle, extra?: Partial<Item>): Item => ({
  id,
  state,
  ...extra,
});
const ids = (lines: Array<{ item: Item }>) => lines.map((l) => l.item.id);

describe("pendingView — one list: your messages, waiting", () => {
  test("claimed and running have NO line — the transcript owns them", () => {
    expect(pendingView([item("a", "claimed"), item("b", "running")])).toEqual([]);
  });

  test("local and engine-queued items are pending and editable, in order", () => {
    const lines = pendingView([
      item("local", undefined),
      item("q", "queued", { accepted: true }),
    ]);
    expect(ids(lines)).toEqual(["local", "q"]);
    expect(lines.every((l) => l.editable)).toBe(true);
    expect(lines.every((l) => l.error === undefined)).toBe(true);
  });

  test("failed and ambiguous keep their text with an error, never vanish", () => {
    const lines = pendingView([
      item("f", "failed", { accepted: true, error: "profile rejected" }),
      item("amb", "ambiguous", {
        accepted: true,
        error:
          "Wasn't sent — the server restarted while this was running. It may have already made changes.",
      }),
    ]);
    expect(ids(lines)).toEqual(["f", "amb"]);
    expect(lines[0]?.error).toBe("profile rejected");
    expect(lines[1]?.error).toMatch(/may have already made changes/);
    // Engine-settled failures retry by re-enqueue, not in-place edit.
    expect(lines.every((l) => !l.editable)).toBe(true);
  });

  test("an engine-refused local item is an errored, editable line — editing IS the retry", () => {
    const lines = pendingView([item("refused", undefined, { error: "bad envelope" })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.editable).toBe(true);
    expect(lines[0]?.error).toBe("bad envelope");
  });

  test("terminal items belong to no surface", () => {
    expect(pendingView([item("c", "committed"), item("x", "cancelled")])).toEqual([]);
    expect(isTerminalQueueState("committed")).toBe(true);
    expect(isTerminalQueueState("queued")).toBe(false);
  });

  test("SERVER-AUTHORED MACHINERY IS NOT A LINE, in any lifecycle state", () => {
    // The engine writes its own tickets into the same queue this strip polls,
    // and every one of them is `queued` before it runs — the exact state the
    // strip advertises as "your message, waiting to send". A wake ticket's text
    // is the raw sentinel and a watch ticket's is server-authored prose; neither
    // was typed, neither may be edited, and a Discard click on either would
    // cancel machinery.
    expect(
      pendingView([
        item("wake:u-1:9", "queued", { accepted: true, kind: "wake", hidden: true }),
        item("watch:w-1:done", "queued", { accepted: true, kind: "watch" }),
      ]),
    ).toEqual([]);
    // …and a machinery ticket that FAILED is not an errored line either: the
    // errored-line affordance is Retry/Discard, and neither is the user's to
    // press for a turn they did not author.
    expect(
      pendingView([item("wake:u-1:9", "failed", { accepted: true, kind: "wake", error: "no CLI" })]),
    ).toEqual([]);
  });

  test("absent `kind` is a user message — every queue written before machinery existed", () => {
    expect(ids(pendingView([item("local"), item("q", "queued", { accepted: true })]))).toEqual([
      "local",
      "q",
    ]);
    // An explicit "user" reads the same as an absent one; core writes neither,
    // but a reader must not care which spelling reached it.
    expect(ids(pendingView([item("u", "queued", { accepted: true, kind: "user" })]))).toEqual(["u"]);
    // `hidden` alone is enough — a kind this build does not know about that
    // says its message is not to be shown is still not a line.
    expect(pendingView([item("h", "queued", { accepted: true, hidden: true })])).toEqual([]);
  });

  test("isUserQueueItem is the one spelling of `did a human author this`", () => {
    // Exported because the strip is not the only surface that asks: Stop's
    // pull-back reads it too, and a second hand-written copy of the rule is how
    // one of them ends up cancelling machinery.
    expect(isUserQueueItem({})).toBe(true);
    expect(isUserQueueItem({ kind: "user" })).toBe(true);
    expect(isUserQueueItem({ kind: "wake", hidden: true })).toBe(false);
    expect(isUserQueueItem({ kind: "watch" })).toBe(false);
    expect(isUserQueueItem({ hidden: true })).toBe(false);
  });
});

describe("plainQueueError — one sentence, never a stack trace", () => {
  test("maps conflict, refusal, and transport failures to plain sentences", () => {
    expect(plainQueueError(new Error("revision conflict: expected 3, found 4"))).toMatch(
      /Someone else edited/,
    );
    expect(plainQueueError("Queue was not accepted: HTTP 400")).toMatch(/didn't accept/);
    expect(plainQueueError("TypeError: Failed to fetch")).toMatch(/Couldn't reach the server/);
  });

  test("a short human sentence passes through; a long blob does not", () => {
    expect(plainQueueError("profile rejected")).toBe("profile rejected");
    expect(plainQueueError("x".repeat(400))).toMatch(/Something went wrong/);
  });
});

describe("the pending strip renders the view, not the engine", () => {
  test("one strip block, fed by pendingView, with ordinals only when plural", () => {
    const src = sessionView();
    expect(src).toContain("pendingView(messageQueue)");
    expect(src).toContain("{pendingLines.map((line, i) => (");
    expect(src).toContain("index={pendingLines.length > 1 ? i + 1 : undefined}");
    // The old three-bucket render sites are gone entirely.
    expect(src).not.toContain("queueView.waiting");
    expect(src).not.toContain("queueView.inFlight");
    expect(src).not.toContain("queueView.attention");
  });

  test("no lifecycle vocabulary can render: the chip has no state prop", () => {
    const src = sessionView();
    const start = src.indexOf("function QueueChip(");
    const chip = src.slice(start, src.indexOf("// `RenderItem` / `groupParts` moved", start));
    expect(chip).not.toContain("state?:");
    expect(chip).not.toContain("badge");
    // A line that did not send offers the two acts that are real.
    expect(chip).toContain("Retry");
    expect(chip).toContain("Discard");
  });

  test("no Resume mode anywhere: a Stop HOLDS client-side and one act releases", () => {
    const src = sessionView();
    expect(src).not.toContain("Queue paused");
    expect(src).not.toContain("resumeEngineQueue");
    // The hold and its exits: Send now on the strip, or the next send.
    expect(src).toContain("Held — sends with your next message");
    expect(src).toContain("releaseHeldMessages");
    expect(src).toContain("setHeldAfterStop(false);");
    // Stop pulls engine-queued items back to local drafts (no server drain).
    const stop = src.slice(src.indexOf("const stopTurn = useCallback"));
    expect(stop).toContain('item.accepted && item.state === "queued"');
  });

  test("Stop pulls back the USER's queue, and cannot take machinery with it", () => {
    // A queued wake swept into the pull-back is DELETEd — cancelled server-side
    // while its key stays in the envelope forever — and then re-enqueued through
    // buildTurnPayload, which cannot carry `kind`/`hidden`, so the retained key
    // hands the cancelled item straight back. The outcome is lost with no later
    // scan able to mint it again, the "Waking for …" marker never clears, and
    // the wake poll never quiesces. Both halves of the pull-back are pinned: the
    // server-side cancel and the local demotion that feeds the re-enqueue.
    const src = sessionView();
    const stop = src.slice(src.indexOf("const stopTurn = useCallback"));
    const cancels = stop.slice(0, stop.indexOf("const pullBack") + 400);
    expect(cancels).toContain("isUserQueueItem(item)");
    expect(stop).toContain('item.accepted && item.state === "queued" && isUserQueueItem(item)');
  });

  test("ArrowUp walks the strip via recallTarget — a pure index, not component arithmetic", () => {
    // F1 (message-lifecycle): the walk previews without destroying (lines
    // leave the strip only at COMMIT — typing or sending), ArrowDown walks
    // back with the displaced draft restored, and the lost race is a strip
    // line with Stop — the F1→F2 handoff — never an error banner.
    const src = sessionView();
    expect(src).toContain("recallTarget(pendingLines, recallCursorRef.current, dir)");
    expect(src).toContain('e.key === "ArrowUp"');
    expect(src).toContain('(walking || e.currentTarget.value === "")');
    expect(src).toContain('e.key === "ArrowDown" && walking');
    expect(src).toContain("That one already went.");
    // Attachments travel with the recall — the whole message comes back.
    expect(src).toContain("filesFromItems");
  });

  test("the dock speaks the same words: no state badges, no paused banner", () => {
    const src = dock();
    expect(src).not.toContain(">queued<");
    expect(src).not.toContain("Queue paused");
    expect(src).toContain("queued.length > 1 && (");
  });
});
