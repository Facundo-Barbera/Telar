"use client";

/**
 * THE STANCE — the Spool's one front door, per `docs/spool-definition.md` §13.
 *
 * ── WHY BOTH PREDECESSORS DIED ───────────────────────────────────────────────
 * The v1 brief and the v2 canvas both answered "what is in the store?" —
 * subjects, threads, known/unanswered counts. Nobody arrives with that
 * question. They arrive with three: what needs me, what is being handled, what
 * happened while I was gone. A screen organised by the memory model's taxonomy
 * is a database presenting itself; this one is organised by OWNERSHIP AND
 * STATE — whose hands is a thing in, and is it moving. The taxonomy survives
 * as detail inside an opened item, never as the front page's vocabulary.
 *
 * ── THE ROOM: STANCE | TRAY | CHAT (§13.4) ───────────────────────────────────
 * Three columns. The stance holds; the chat talks; between them the TRAY is
 * summoned, never resident — a stance line opens its packet there, the night
 * line opens the record, a permit glyph opens the grants, and closing it is
 * two columns again. `/spool/[id]` survives as a deep link that lands in the
 * room with the tray open. No route navigation happens inside the room.
 *
 * ── SCOPE IS THE ROOM'S APERTURE, AND ITS OWN VIEWING CHOICE ─────────────────
 * everything | one subject. The room OWNS its scope — loops §8.1, "a glance
 * is not work" — seeded once from the focus log's newest open entry on
 * arrival, then moved immediately by a click. It is not read live off the
 * focus log's "newest entry", because the log allows several subjects open
 * at once (opening one never ends another) and re-opening one that is
 * already open is a no-op ON THE LOG; a live read would leave the room
 * silently stuck whenever a click landed on an already-open subject.
 * Entering scope still opens (or re-opens) a focus entry — the log keeps
 * its own honest record of where you went — widening still ends the
 * newest one (`paused` — a fact about attention, never about the work); the
 * room's own slot simply no longer waits on that round trip to move.
 *
 * THE APERTURE IS COMMITTED (loops §6): WIDE IS FOR CHOOSING — one line per
 * subject, the focal card, the housekeeping fold, the morning report — and
 * FOCUS IS FOR DOING: one subject's items in the full four-band grammar, with
 * the folded periphery compressed to one line that says, deterministically,
 * whether anything in it blocks you. Same page, same capability set, the chat
 * as hinge; neither posture hides the other's alarms.
 *
 * ── THE WORLD IS LOOKED AT, NEVER SUBSCRIBED TO (loops §4) ───────────────────
 * The room paints instantly from the STORED looks and lets freshness arrive:
 * a reconcile is PULLED on arrival and on focus — the two reasons a person
 * would glance — never on a timer. Every freshness label (`lastLooked`, an
 * observation's `seen`) is quoted verbatim with attribution; a failed look is
 * a sentence beside the stale label, not a colour. Observations are WORLD
 * FACTS in their own words — at most two verbs each, one that opens work and
 * "Noted", which drains through the ack route and deletes nothing. They live
 * WITH their subject: under its line when wide, in the "Since your last look"
 * strip when focused — never a fifth band, never a Needs-you claim.
 *
 * ── ONE ITEM, ONE BAND · ONE FOCAL POINT ─────────────────────────────────────
 * Strict precedence (settled answers stay settled; waiting-on-person beats
 * in-its-hands beats needs-you), enforced by set membership in `deriveStance`.
 * Needs you ranks in code — decisions and questions, then commitments to
 * people, then prepared work — gives its first entry card treatment, groups
 * the rest under subject headers, folds filing into one line, caps what shows.
 *
 * ── DRAWN, NEVER ASKED — AND IT TEACHES ITS OWN VERBS ────────────────────────
 * Everything folds records that already exist. The night's plan renders as a
 * RECORD (§11.3) — no Approve control here or anywhere. Where a line has a
 * chat verb it is WIRED: the affordance prefills the composer and the human
 * presses send. The chat's openers come from this same derivation, so the two
 * halves cannot disagree about what there is to do.
 *
 * ── NO CLOCK, NO RED, NO BADGE ───────────────────────────────────────────────
 * §3.2: a clock may drive an agent, never a renderer. Every time on this
 * screen is a store-minted display label. Nothing is tinted for urgency; the
 * counts that exist — Settled's, the fold's, "and N more", the footer's
 * conservation pair — each describe what sits under the control they sit on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  HandIcon,
  Loader2Icon,
  MessageCircleIcon,
  MoonIcon,
  ShieldIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type {
  SpoolDeskCard,
  SpoolFocusDay,
  SpoolLane,
  SpoolLookDigestLine,
  SpoolLookOutcome,
  SpoolMap,
  SpoolNight,
  SpoolNightJob,
  SpoolObservation,
  SpoolPickup,
  SpoolSearchHit,
  SpoolSubject,
  SpoolSubjectGroup,
  SpoolSubjectRow,
  SpoolUnreadable,
} from "@telar/engine-client";
import { CloseCheckbox, SelectHotspot, SubjectDot } from "@/components/spool/chips";
import { ConfirmDialog } from "@/components/spool/dialogs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Lobby } from "@/components/spool/lobby";
import { SubjectRoom } from "@/components/spool/room";
import { MasterChat } from "@/components/spool/master-chat";
import { SpoolHeader } from "@/components/spool/header";
import { SpoolTray, type TrayFace } from "@/components/spool/tray";
import { closeItemByHand, reopenItemByHand } from "@/lib/spool-close";
import { EditableTitle, RowDisclosure } from "@/components/spool/task-row";
import { clearSpoolRoom, publishSpoolRoom, type SpoolRoomState } from "@/lib/spool-room";
import { formatDay, todayDay } from "@/lib/spool-today";
import { describeWork, useSpoolWork, type SpoolWorkView } from "@/lib/spool-work";
import { cn } from "@/lib/utils";

/**
 * A JOB'S OUTCOME AS A MARK, all of them neutral. The night surface colours
 * `failed`; the stance does not, deliberately — the front page carries no
 * state colour at all, so the words do the work and nothing on arrival can
 * read as an alarm. Refused keeps its hand: it is the system working, naming
 * the one thing only a human can do.
 */
const JOB_MARK: Record<SpoolNightJob["state"], { Icon: typeof CheckIcon; tone: string; label: string }> = {
  done: { Icon: CheckIcon, tone: "text-muted-foreground", label: "done" },
  refused: { Icon: HandIcon, tone: "text-muted-foreground", label: "refused" },
  failed: { Icon: TriangleAlertIcon, tone: "text-muted-foreground", label: "failed" },
  pending: { Icon: MoonIcon, tone: "text-muted-foreground/50", label: "queued" },
};

/** How many lines Needs you shows before "and N more" — the card and the
 *  filing fold ride outside it. A band that shows everything at equal volume
 *  is the queue again. */
const NEEDS_VISIBLE = 5;

/**
 * Clamp at a word boundary with a real ellipsis. The CSS `truncate` still
 * guards the layout; this guards the STRINGS this file composes, so a clause
 * never ends mid-word when it is quoted into a card, a chat opener or a
 * prefilled message.
 */
function clip(text: string, max = 96): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return `${text.slice(0, cut > max / 2 ? cut : max).trimEnd()}…`;
}

/** One Needs-you entry, already ranked. `ask` is the chat verb it teaches:
 *  text the affordance prefills into the composer, never auto-sent. */
export type NeedEntry = {
  key: string;
  /** 1 · decisions and questions blocked on you; 2 · commitments to people;
   *  3 · prepared work awaiting a look. Housekeeping is not a tier — it folds. */
  tier: 1 | 2 | 3;
  subject: string;
  said?: string;
  title: string;
  meta?: string;
  itemId?: string;
  /** The thread behind the claim, when one exists — the address the Settle
   *  verb needs. A prepared card with no thread has nothing to settle. */
  threadId?: string;
  /** Why it outranks the rest — the card renders this, composed from fields
   *  the records already carry. */
  why?: string;
  questions?: string[];
  ask?: string;
  /** THE WORLD CONFRONTING THE CLAIM — an unacknowledged observation whose ref
   *  names the same numbered thing this claim is about. STORED WORDS ONLY: the
   *  observation's own text and its seen label, quoted under the row. It
   *  changes nothing — not the band, not the tier — because a confronted claim
   *  still needs you until YOU settle it. */
  confront?: { text: string; seen: string };
};

type HousekeepingLine = { id: string; said?: string; title: string };

/** What the settle dialog needs to open — §9.4 widened Settle to EVERY
 *  thread-backed claim, so the target is no longer always a NeedEntry: a
 *  Waiting-on-others or In-its-hands row summons the same dialog. The
 *  confrontation, when one exists, seeds the prefill; absent means the
 *  answer starts empty and stays the human's. */
export type SettleTarget = {
  subject: string;
  threadId?: string;
  said?: string;
  title: string;
  confront?: { text: string; seen: string };
};

/** One folded subject, and whether anything in it blocks the human — the
 *  scoped stance's honesty about what it is not showing. `moved` is the
 *  periphery's other fact: the world shifted under a subject you are not on,
 *  which the meanwhile line names without making a claim on you. */
type FoldedSubject = { subject: string; blocking: number; moved: number };

/** One thing that moved since the last look, resolved for rendering: the
 *  observation in its own words, plus the packet it maps to when one of its
 *  refs names an item filed to this subject. */
type MovedLine = { observation: SpoolObservation; itemId?: string };

/** One row of the Done shelf — §9.3: closed DRAINS to a visible shelf, never
 *  deletes. Said-first like every line, plus the store's own closed label,
 *  QUOTED — "closed Tue 16:42" is a fact the store minted, not a time this
 *  code computed. */
type DoneRow = { id: string; said?: string; title: string; subject: string; closedLabel: string };

/**
 * What the room knows about a subject's freshness — QUOTED from the stored
 * look, never computed. `hasTerrain` decides whether a freshness line exists
 * at all: a subject with no terrain has nowhere to look, and that is the
 * ordinary case, not a degraded one (loops §3's no-code test).
 */
type SubjectLook = {
  hasTerrain: boolean;
  lastLooked?: string;
  error?: string;
  moved: MovedLine[];
  /** THE MOVEMENT DIGEST — the engine's own compression of `moved` into one
   *  line per group (loops §10's volume work), quoted whole. The room renders
   *  the digest and keeps the observations one expansion away, so the flood
   *  never paints first. */
  digest: SpoolLookDigestLine[];
};

/** One filed item awaiting its turn, and the lane group it renders under —
 *  the focused residence's inventory, gated by the bands' precedence sets so
 *  a claimed item never repeats. `header` QUOTES the lane's stored label and
 *  window; absent means the row sits in no stack, a resting state. */
type PreparedGroup = {
  key: string;
  header?: string;
  /** `tags` and `pinnedDay` ride along so §13.8's per-row disclosure has
   *  something to show without a second read — the same fields `ScheduledRow`
   *  below carries for the same reason. */
  rows: { id: string; said?: string; title: string; tags: string[]; pinnedDay?: string }[];
};

/** One line of the wide, CHOOSING view — a subject, whose turn it is there in
 *  counts, and its freshness. Never its items: that is what focus is for.
 *  `area` and `color` are the subject's IDENTITY (loops §8), joined by key
 *  from the subject records: whose the line is, never how urgent. */
type SubjectLineModel = {
  subject: string;
  needs: number;
  withAgent: number;
  onPerson: number;
  look: SubjectLook;
  area?: string;
  color?: string;
  /** The user's own hand-order within an area (the rail's reorder-by-drag
   *  pass) — joined from the subject record exactly like `area`/`color`. Cast
   *  at the join, not typed on `SpoolSubject` itself: the field is landing on
   *  the engine's side of the wire in the same pass, and this file's job is
   *  only to carry it through, not to own it. */
  rank?: number;
};

/** Reads `rank` off a subject record without widening `SpoolSubject` itself
 *  — the field is landing on the engine's side of the wire in the same pass
 *  that gave the rail its reorder drag, so this is the one bridge point
 *  until `SpoolSubject` carries it natively. */
function subjectRank(record?: SpoolSubject): number | undefined {
  const rank = (record as (SpoolSubject & { rank?: unknown }) | undefined)?.rank;
  return typeof rank === "number" ? rank : undefined;
}

/** One pinned item in the Scheduled scope's flat list — the user's own day,
 *  the words, and the subject's identity so eight lives on one list stay
 *  tellable apart. Sorted by `day` as a plain string compare of ISO dates —
 *  a placement, never an urgency computation. */
type ScheduledRow = {
  id: string;
  said?: string;
  title: string;
  subject: string;
  color?: string;
  day: string;
  /** §13.8's per-row disclosure fields — the same reasoning as `PreparedGroup`
   *  above: carried once here rather than re-read per row. */
  lane?: string;
  tags: string[];
};

/**
 * WIDE GROUPS BY AREA — loops §8.1, Reminders' list-groups. Headers come from
 * the STORED `area` values only, in the user's own words, alphabetically so
 * the grouping is deterministic. Subjects with no area sit last under NO
 * header — an invented "Other" would be the system naming a group the user
 * never made, which is exactly what §8's provenance rule forbids.
 */
function groupByArea(lines: SubjectLineModel[]): { area?: string; lines: SubjectLineModel[] }[] {
  const named = new Map<string, SubjectLineModel[]>();
  const bare: SubjectLineModel[] = [];
  for (const line of lines) {
    if (line.area) named.set(line.area, [...(named.get(line.area) ?? []), line]);
    else bare.push(line);
  }
  return [
    ...[...named.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, ls]) => ({ area, lines: ls })),
    ...(bare.length > 0 ? [{ lines: bare }] : []),
  ];
}

/**
 * THE WHOLE PAGE AS ONE DERIVATION — pure, so the openers the chat offers,
 * the bands the stance draws and the context line every turn carries come
 * from one pass over one snapshot and cannot disagree about what exists.
 * `scope` is the aperture: the full model is built first, then filtered, so
 * the fold line can say what the filter removed.
 */
export function deriveStance(
  map: SpoolMap | null,
  focus: { pickup: SpoolPickup; days: SpoolFocusDay[] } | null,
  night: SpoolNight | null,
  desk: SpoolDeskCard[],
  scope: string | undefined,
  looks: SpoolLookOutcome[],
  // Defaulted, deliberately: a hot-reloaded caller mid-edit once invoked this
  // with the old arity and took the whole room down with a 500. A missing
  // inventory renders an emptier residence, never a dead one.
  inventory: SpoolSubjectGroup[] = [],
  lanes: SpoolLane[] = [],
  /** Which day is today, from the ONE sanctioned helper (`lib/spool-today`,
   *  §3.2 as amended 2026-08-16) — so a pin whose day has come can join
   *  "Needs you" in the user's own voice. Defaulted empty like `inventory`,
   *  and an empty today matches no pin: an emptier room, never a dead one. */
  today = "",
  /** The subject RECORDS — area, color, terrain, permits — joined by key onto
   *  everything that already names a subject. Views are join-by-key: cards
   *  and threads carry only the key, and this one snapshot read is what makes
   *  identity available to lines, board, calendar and tray without a second
   *  fetch anywhere. Defaulted empty like `inventory`: a room with no
   *  identity records is plainer, never dead. */
  records: SpoolSubject[] = [],
) {
  /** THE JOIN — key → record, once, for every consumer of this derivation. */
  const identity = new Map((records ?? []).map((r) => [r.key, r]));
  const threads = (map?.subjects ?? []).flatMap((s) => s.threads.map((view) => ({ subject: s.subject, view })));
  const settledAll = threads.filter((t) => t.view.thread.settled);
  const openThreads = threads.filter((t) => !t.view.thread.settled);
  const onPersonAll = openThreads.filter((t) => t.view.thread.waiting?.kind === "person");
  const withAgentAll = openThreads.filter((t) => t.view.thread.waiting?.kind === "agent");
  const stuckOnYou = openThreads.filter((t) => t.view.thread.waiting?.kind === "you");

  /**
   * WHAT THE OTHER BANDS ALREADY CLAIM. The precedence rule cashes out as two
   * sets: anything reachable from a waiting-on-person or with-the-agent thread
   * — the thread itself or any capture that fed it — must not surface again
   * under Needs you, whichever record happens to also mention it.
   */
  const claimedThreads = new Set([...onPersonAll, ...withAgentAll].map((t) => t.view.thread.id));
  const claimedItems = new Set([...onPersonAll, ...withAgentAll].flatMap((t) => t.view.items.map((i) => i.id)));

  const needsAll: NeedEntry[] = [];

  for (const t of stuckOnYou) {
    const said = t.view.items.find((item) => item.said)?.said;
    const words = said ?? t.view.thread.handle?.trim() ?? t.view.thread.question;
    const first = t.view.items[0];
    needsAll.push({
      key: `thread:${t.view.thread.id}`,
      tier: 1,
      subject: t.subject,
      ...(said ? { said } : {}),
      title: t.view.thread.handle?.trim() || t.view.thread.question,
      meta: clip(t.view.thread.waiting?.note ?? "stuck on you"),
      threadId: t.view.thread.id,
      ...(first ? { itemId: first.id } : {}),
      why: clip(t.view.thread.waiting?.note ?? "it is waiting on your answer"),
      ask: `About “${clip(words, 60)}” — here is my answer: `,
    });
  }
  for (const job of (night?.jobs ?? []).filter((j) => j.openQuestions?.length)) {
    if (job.itemId && claimedItems.has(job.itemId)) continue;
    needsAll.push({
      key: `night-q:${job.id}`,
      tier: 1,
      subject: job.subject ?? "elsewhere",
      title: job.title,
      ...(job.itemId ? { itemId: job.itemId } : {}),
      why: "the night could not answer this alone",
      questions: job.openQuestions ?? [],
      ask: `About “${clip(job.title, 60)}”: `,
    });
  }
  for (const job of (night?.jobs ?? []).filter((j) => j.state === "refused")) {
    if (job.itemId && claimedItems.has(job.itemId)) continue;
    needsAll.push({
      key: `night-r:${job.id}`,
      tier: 1,
      subject: job.subject ?? "elsewhere",
      title: job.title,
      meta: clip(job.note ?? "the night refused this — it needs something only you can give"),
      ...(job.itemId ? { itemId: job.itemId } : {}),
      why: clip(job.note ?? "the night refused it"),
    });
  }
  for (const line of focus?.pickup.waiting ?? []) {
    if (line.threadId && claimedThreads.has(line.threadId)) continue;
    if (line.itemId && claimedItems.has(line.itemId)) continue;
    needsAll.push({
      key: `grounded:${line.subject}:${line.threadId ?? line.itemId ?? line.derived}`,
      tier: 2,
      subject: line.subject,
      ...(line.said ? { said: line.said } : {}),
      title: line.derived,
      meta: line.said ? clip(line.derived) : undefined,
      ...(line.threadId ? { threadId: line.threadId } : {}),
      ...(line.itemId ? { itemId: line.itemId } : {}),
      why: clip(line.derived),
    } as NeedEntry);
  }

  /**
   * FILING IS ONE CHORE, NOT FIVE ROWS. An unfiled capture and an unplaced
   * item both ask for the same small act, so they fold into a single line —
   * classified off the card's own booleans (`unplaced`, absent `project`),
   * never off the wording of `needsYou`. The fold stays whole under scope:
   * chores mostly belong to no subject, which is the thing being fixed.
   */
  /** THE ACTIVE-SLICE FILTER — §9.3. A closed capture stays in every payload
   *  (conservation is the engine's; the totals line still counts it) and it is
   *  THE WEB that keeps it off the active desk: chores, pins, cards and the
   *  prepared inventory all skip `closed` here, and the item reappears only on
   *  the Done shelf, ticked. */
  const floating = (map?.floating ?? []).filter((f) => !f.closed);
  const floatingIds = new Set(floating.map((f) => f.id));
  const choreCards = desk.filter(
    (c) => (c.unplaced || !c.project) && !c.closed && !floatingIds.has(c.id) && !claimedItems.has(c.id),
  );
  const housekeeping: HousekeepingLine[] = [
    ...floating.map((f) => ({ id: f.id, ...(f.said ? { said: f.said } : {}), title: f.title })),
    ...choreCards.map((c) => ({ id: c.id, title: c.title })),
  ];

  /**
   * THE STANCE FEELS THE PIN — loops §7. An item the user pinned to today or
   * earlier joins "Needs you" at tier 2: it is YOU interrupting yourself, not
   * the system knocking, so it ranks with your commitments rather than above
   * your open questions. The wording is the amendment's own quiet voice —
   * today's pin says so plainly; a slipped one is recorded honestly, never
   * punished: no red, no "overdue", no count of days. `today` comes from the
   * one sanctioned helper, and the day comparison is a plain string compare
   * of two ISO dates — a placement, never an urgency computation. One item
   * one band still holds: anything a band already claims stays where it is.
   */
  const housekeepingIds = new Set(housekeeping.map((h) => h.id));
  const settledItems = new Set(settledAll.flatMap((t) => t.view.items.map((i) => i.id)));
  if (today) {
    for (const group of inventory ?? []) {
      for (const row of group.rows) {
        // A closed pin asks for nothing — the hand already answered it.
        if (row.item.closed) continue;
        const day = row.item.pinned?.day;
        if (!day || day > today) continue;
        const id = row.item.id;
        if (claimedItems.has(id) || settledItems.has(id) || housekeepingIds.has(id)) continue;
        if (needsAll.some((e) => e.itemId === id)) continue;
        const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
        const why =
          day === today ? "you pinned this to today" : `you pinned this to ${formatDay(day)} — it's still here`;
        needsAll.push({
          key: `pin:${id}`,
          tier: 2,
          subject: group.project ?? "elsewhere",
          ...(said ? { said } : {}),
          title: row.item.title,
          meta: why,
          itemId: id,
          why,
        });
      }
    }
  }

  const nightItemIds = new Set(needsAll.filter((e) => e.key.startsWith("night")).map((e) => e.itemId).filter(Boolean));
  for (const card of desk) {
    const chore = card.unplaced || !card.project;
    // A pinned card already asked at tier 2 — one item, one entry. A CLOSED
    // card asks for nothing: the engine already blanks its `needsYou`, and
    // the filter here is what keeps its `drafted` stage from re-claiming.
    if (chore || card.closed || claimedItems.has(card.id) || nightItemIds.has(card.id)) continue;
    if (needsAll.some((e) => e.itemId === card.id)) continue;
    if (!(card.needsYou || card.stage === "drafted")) continue;
    needsAll.push({
      key: `card:${card.id}`,
      tier: 3,
      subject: card.project ?? "elsewhere",
      title: card.title,
      meta: clip(card.needsYou ?? "an approach is written — nothing runs until you look"),
      itemId: card.id,
      why: clip(card.needsYou ?? "an approach is waiting for your look"),
    });
  }

  needsAll.sort((a, b) => a.tier - b.tier);

  /**
   * THE WORLD CONFRONTS THE CLAIM. A claim-thread stuck on you and an
   * observation about the same numbered thing were separate records that never
   * met: the room said "espera mi revisión" in one band and "PR #418 merged
   * since your last look" under the subject line, and neither sentence knew
   * the other existed. This join makes them meet — ON THE ROW, as a quiet
   * annotation quoting the observation's STORED words and seen label — and
   * changes nothing else: not the band, not the tier, because a confronted
   * claim still needs you until YOU settle it. Nothing here settles; the one
   * settle path is the human's click through the dialog below.
   *
   * The match is the packet-match idiom: a ref's number against the item's
   * mirror (`ozom-gv#418`), the claim's own title, or the item's title, with
   * the boundary in the regex so `#41` cannot claim `#412`.
   */
  const namedBy = new Map<string, { mirrored?: string; title: string }>();
  for (const group of inventory ?? []) {
    for (const row of group.rows) {
      namedBy.set(row.item.id, {
        ...(row.item.mirrored ? { mirrored: row.item.mirrored } : {}),
        title: row.item.title,
      });
    }
  }
  for (const card of desk) {
    if (!namedBy.has(card.id)) {
      namedBy.set(card.id, { ...(card.mirrored ? { mirrored: card.mirrored } : {}), title: card.title });
    }
  }
  for (const entry of needsAll) {
    const outcome = looks.find((l) => l.subject === entry.subject);
    const named = entry.itemId ? namedBy.get(entry.itemId) : undefined;
    const texts = [entry.title, named?.title, named?.mirrored].filter((t): t is string => !!t);
    const hit = (outcome?.look?.observations ?? [])
      .filter((o) => !o.acknowledged)
      .find((o) => o.refs.some((ref) => texts.some((t) => new RegExp(`#${ref.number}(?![0-9])`).test(t))));
    if (hit) entry.confront = { text: hit.text, seen: hit.seen };
  }

  /**
   * THE WORLD'S MOVEMENT, RESOLVED PER SUBJECT — loops §4. Unacknowledged
   * observations are WORLD FACTS, not claims on the user: they never join
   * `needsAll` and never inflate a tier. Each maps to a packet when one of
   * its refs' numbers appears in an item filed to the subject — that is the
   * verb that opens work — and otherwise its verb opens the subject's face.
   * Everything quoted here (`lastLooked`, the observation text, `error`) is
   * the store's or `gh`'s own sentence; nothing is computed from a clock.
   */
  const lookFor = (subject: string): SubjectLook => {
    const outcome = looks.find((l) => l.subject === subject);
    if (!outcome) return { hasTerrain: false, moved: [], digest: [] };
    const cards = desk.filter((c) => c.project === subject);
    const moved: MovedLine[] = (outcome.look?.observations ?? [])
      .filter((o) => !o.acknowledged)
      .map((observation) => {
        // `#41` must not claim `#412` — the boundary is part of the match.
        const card = cards.find((c) =>
          observation.refs.some((ref) => new RegExp(`#${ref.number}(?![0-9])`).test(c.title)),
        );
        return { observation, ...(card ? { itemId: card.id } : {}) };
      });
    return {
      hasTerrain: !!outcome.terrain,
      ...(outcome.look?.lastLooked ? { lastLooked: outcome.look.lastLooked } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      moved,
      digest: outcome.digest ?? [],
    };
  };

  /**
   * THE APERTURE. Filtered AFTER the full build, so the fold line states what
   * it removed — per folded subject, how many tier-1 entries are waiting.
   * "Nothing in them blocks you" is a claim this code checks, not a hope.
   */
  const subjectsPresent = [
    ...new Set([
      // The map's own registry first: a subject whose captures are all loose
      // has no band entry yet and still exists — the openers and the fold
      // must be able to name it.
      ...(map?.subjects ?? []).map((s) => s.subject),
      ...needsAll.map((e) => e.subject),
      ...onPersonAll.map((t) => t.subject),
      ...withAgentAll.map((t) => t.subject),
      ...settledAll.map((t) => t.subject),
      // A terrain-backed subject whose packets are all settled still exists —
      // the choosing view must be able to say the world moved under it.
      ...looks.map((l) => l.subject),
    ]),
  ];
  const folded: FoldedSubject[] = scope
    ? subjectsPresent
        .filter((s) => s !== scope)
        .map((s) => ({
          subject: s,
          blocking: needsAll.filter((e) => e.subject === s && e.tier === 1).length,
          moved: lookFor(s).moved.length,
        }))
    : [];

  /**
   * WAITING ITS TURN — the focused subject's ACTUAL filed items, in the room.
   * Loops §6: "focused shows one subject's actual items in full grammar." An
   * item with no work-state claim belongs to no band, and twelve of those
   * rendering as four nearly-empty bands is the original "all my tasks
   * collapsed into one thing" complaint re-created — so the residence shows
   * the inventory itself, grouped by the lane's OWN stored words (label and
   * window, quoted — a window is coarse prose, never a schedule this code
   * reads). Gated by the same precedence sets as everything else: an item a
   * band already claims does not repeat here.
   */
  const claimedByBands = new Set([
    ...claimedItems,
    ...needsAll.map((e) => e.itemId).filter((id): id is string => !!id),
    /**
     * FIXED 2026-08-19, §13.8: housekeeping's chores are claimed here ONLY in
     * the wide view, where the fold below actually renders and owns them.
     * `unplaced` does NOT mean "no subject" — the seed lane resolves an
     * unfiled item's `lane` to "unfiled", not its `project` to nothing, so a
     * hand-captured item that could not be placed in a lane still names its
     * real subject. A focused room suppresses the housekeeping fold entirely
     * (`housekeeping: scope ? [] : housekeeping`, below) — claiming these ids
     * unconditionally meant an unplaced item belonging to THIS subject was
     * excluded from `prepared` by a fold that had just gone quiet, so it
     * rendered nowhere at all. A drive caught this: a hand-typed item POSTed
     * clean and then never appeared in its own room.
     */
    ...(scope ? [] : housekeeping.map((h) => h.id)),
  ]);
  const laneRecords = new Map((lanes ?? []).map((l) => [l.key, l]));
  const prepared: PreparedGroup[] = [];
  const scopeRows = scope ? ((inventory ?? []).find((g) => g.project === scope)?.rows ?? []) : [];
  if (scope) {
    for (const row of scopeRows) {
      if (row.item.closed) continue;
      if (claimedByBands.has(row.item.id)) continue;
      const lane = row.lane ? laneRecords.get(row.lane) : undefined;
      const header = lane ? `${lane.label}${lane.window ? ` — ${lane.window}` : ""}` : row.lane;
      const key = row.lane ?? "";
      let group = prepared.find((g) => g.key === key);
      if (!group) {
        group = { key, ...(header ? { header } : {}), rows: [] };
        prepared.push(group);
      }
      const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
      group.rows.push({
        id: row.item.id,
        ...(said ? { said } : {}),
        title: row.item.title,
        tags: row.item.tags ?? [],
        ...(row.item.pinned ? { pinnedDay: row.item.pinned.day } : {}),
      });
    }
  }

  /** The CHOOSING view — one line per subject, wide only. Built after the
   *  precedence machinery so its counts are the bands' own claims compressed,
   *  never a second derivation that could disagree with them. */
  const lines: SubjectLineModel[] = subjectsPresent.map((subject) => {
    const record = identity.get(subject);
    return {
      subject,
      needs: needsAll.filter((e) => e.subject === subject).length,
      withAgent: withAgentAll.filter((t) => t.subject === subject).length,
      onPerson: onPersonAll.filter((t) => t.subject === subject).length,
      look: lookFor(subject),
      ...(record?.area ? { area: record.area } : {}),
      ...(record?.color ? { color: record.color } : {}),
      ...(subjectRank(record) !== undefined ? { rank: subjectRank(record) } : {}),
    };
  });

  /**
   * THE SCHEDULED SCOPE'S SLICE — loops §8.3: every pinned item, in day
   * order, the flat list Reminders showed. Computed ONLY from properties the
   * user set (the pin), never from the system's opinions; the day order is a
   * plain string sort of the user's own ISO dates. Slipped pins — day before
   * today, still here — come first under their honest sentence, in the same
   * quiet voice as everywhere else: no red, no count of days, whatever hue
   * the subject wears.
   */
  const pinnedAll: ScheduledRow[] = (inventory ?? [])
    .flatMap((group) =>
      group.rows
        .filter((row) => row.item.pinned && !row.item.closed)
        .map((row) => {
          const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
          const color = group.project ? identity.get(group.project)?.color : undefined;
          return {
            id: row.item.id,
            ...(said ? { said } : {}),
            title: row.item.title,
            subject: group.project ?? "elsewhere",
            ...(color ? { color } : {}),
            day: row.item.pinned!.day,
            ...(row.lane ? { lane: row.lane } : {}),
            tags: row.item.tags ?? [],
          };
        }),
    )
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const scheduledSlipped = today ? pinnedAll.filter((r) => r.day < today) : [];
  const scheduledDays: { day: string; rows: ScheduledRow[] }[] = [];
  for (const row of pinnedAll) {
    if (today && row.day < today) continue;
    const last = scheduledDays.at(-1);
    if (last && last.day === row.day) last.rows.push(row);
    else scheduledDays.push({ day: row.day, rows: [row] });
  }

  /**
   * THE DONE SHELF'S ROWS — §9.3: "closed items leave the active desk into a
   * visible Done shelf." Drawn from the same inventory the active slices just
   * filtered, so drained-versus-shown is one predicate read twice, and the
   * closed label is the STORE'S own ("Tue 16:42"), quoted — nothing here
   * reads a clock. Scoped like every other slice: focus shows one subject's
   * done, wide shows all of it.
   */
  const doneAll: DoneRow[] = (inventory ?? []).flatMap((group) =>
    group.rows
      .filter((row) => row.item.closed)
      .map((row) => {
        const said = (row.item.raw ?? "").trim().replace(/\s+/g, " ");
        return {
          id: row.item.id,
          ...(said ? { said } : {}),
          title: row.item.title,
          subject: group.project ?? "elsewhere",
          closedLabel: row.item.closed!.label,
        };
      }),
  );

  const inScope = <T extends { subject: string }>(rows: T[]) =>
    scope ? rows.filter((r) => r.subject === scope) : rows;

  const scopedNightJobs = scope ? (night?.jobs ?? []).filter((j) => j.subject === scope) : (night?.jobs ?? []);
  const nightView = night && (!scope || scopedNightJobs.length > 0) ? { ...night, jobs: scopedNightJobs } : null;

  /**
   * FILING IS UNFILED ONLY WHEN IT TRULY HAS NO SUBJECT — a floating capture
   * (no `project` at all). CORRECTED 2026-08-19, §13.8: this comment used to
   * also claim an unplaced item has "no subject at all, by construction",
   * which is false — `unplaced` describes the LANE (the seed lane could not
   * resolve a stack for it), not the `project`, and a hand-captured item
   * inside a subject room carries that subject's `project` same as any
   * other. Housekeeping's own fold still goes quiet under scope (a focused
   * room shows one subject's full grammar, not every OTHER subject's stray
   * captures beside it) — but an unplaced item that names THIS subject now
   * surfaces in `prepared` instead of vanishing (see `claimedByBands`,
   * above). Wide still sees the whole housekeeping pile.
   */
  return {
    needs: inScope(needsAll),
    housekeeping: scope ? [] : housekeeping,
    onPerson: inScope(onPersonAll),
    withAgent: inScope(withAgentAll),
    settled: inScope(settledAll),
    /**
     * ADDRESSED, AND SCOPED THE SAME WAY AS EVERYTHING ELSE. Several subjects
     * can be open at once — opening a new focus never ends the others — and
     * `pickup.moved` carries every open one's lines, each now naming its own
     * subject (`SpoolMoved`). A focused room shows ONE subject's grammar, so
     * this passes through the same `inScope` filter as the threads above:
     * without it, another open subject's "answered: …" line rendered under
     * THIS room's "In its hands" band with no way to tell it apart.
     */
    moved: inScope(focus?.pickup.moved ?? []),
    proposal: scope ? undefined : focus?.pickup.proposal,
    night: nightView,
    folded,
    scope,
    subjects: subjectsPresent,
    lines,
    scopeLook: scope ? lookFor(scope) : undefined,
    prepared,
    scheduled: { slipped: scheduledSlipped, days: scheduledDays },
    done: inScope(doneAll),
    /**
     * ADDED 2026-08-19, §13.8: the footer's conservation line was reading the
     * WHOLE STORE'S totals inside a focused room — "16 items" when the room
     * held two. `scopeRows` is the same read `prepared`/`pinnedAll`/`doneAll`
     * already draw from (this subject's own group in `inventory`, open and
     * closed alike, which is what "conservation" means here), so a focused
     * room's footer can state ITS OWN count instead of the store's.
     */
    scopeTotals: scope
      ? { totalItems: scopeRows.length, agentsAdded: scopeRows.filter((r) => r.item.provenance === "session").length }
      : undefined,
  };
}

export type StanceModel = ReturnType<typeof deriveStance>;

/**
 * WHAT THE CHAT OFFERS TO DO — drawn from the same derivation as the bands,
 * deterministically. Each opener names REAL state; none is generated. Scoped,
 * the room's own subject leads. The standing last one teaches the module's
 * primary input: the dump.
 */
function deriveOpeners(model: StanceModel): string[] {
  const openers: string[] = [];
  if (model.scope) openers.push(`Where did we leave ${model.scope}?`);
  /**
   * HONEST ABOUT WHAT THE VERB DOES. This used to read "Focus on X" — a
   * promise the chat could not keep even before §13.6: `spool_set_focus`
   * writes the focus log's "you're on X" fact and says plainly that it
   * "does not move their screen" (the user navigates their own rooms).
   * "Focus on" reads as a command to change what is on screen; this reads
   * as what pressing it actually does — records where the user's attention
   * is, nothing more.
   */
  if (!model.scope && model.subjects.length > 0) openers.push(`I'm working on ${model.subjects[0]} — note it`);
  /** MOVEMENT-AWARE, and still drawn — the opener quotes the first observation
   *  the reconcile wrote, in its own words, so the chat's invitation and the
   *  room's freshness line cannot disagree about what moved. */
  const firstMoved = (model.scope ? (model.scopeLook?.moved ?? []) : model.lines.flatMap((l) => l.look.moved))[0];
  if (firstMoved) openers.push(`“${clip(firstMoved.observation.text, 60)}” — what does that unblock?`);
  if (model.housekeeping.length > 0) {
    const n = model.housekeeping.length;
    openers.push(n === 1 ? "File the 1 unfiled item where it belongs" : `File the ${n} unfiled items where they belong`);
  }
  const firstQuestion = model.needs.find((e) => e.tier === 1 && (e.said || e.title));
  if (firstQuestion) {
    openers.push(`Answer the open question on “${clip(firstQuestion.said ?? firstQuestion.title, 40)}”`);
  }
  if (model.night) openers.push("What did last night come to?");
  if (model.needs.some((e) => e.tier === 1)) openers.push("Mark what's waiting on someone");
  openers.push("Dump something new — I'll file it");
  return openers.slice(0, 4);
}

/**
 * THE LINE, and it leads with the human's own words.
 *
 * `said` before `title`, always — §13.2's rule, learned from the packet page:
 * "you recognise it or you do not, immediately." A line with an item behind it
 * SUMMONS THE TRAY on that packet — no route navigation inside the room — and
 * one without renders as text rather than as a control that would be live and
 * silently inert.
 */
export function Row({
  itemId,
  onOpen,
  said,
  title,
  meta,
  confront,
  onSettle,
  close,
  pin,
  select,
  onEditTitle,
  disclose,
}: {
  itemId?: string;
  onOpen?: (id: string) => void;
  said?: string;
  title: string;
  meta?: string;
  /** The world's word against this claim — stored text and seen label, quoted
   *  UNDER the row in the quiet voice. Never a colour, never a band change. */
  confront?: { text: string; seen: string };
  /** The Settle verb — §9.4 made it ALWAYS the hand's on a thread-backed
   *  claim, not only when confronted. It only OPENS the settle dialog —
   *  nothing settles without the confirm click there. */
  onSettle?: () => void;
  /** THE CHECKBOX — §9.1, present on every item-backed row and always
   *  visible. One click closes; the shared control POSTs the dedicated route
   *  and asks nothing first. */
  close?: () => void;
  /** The Pin… hand verb — §9.4: picking a day IS stating it. One PATCH of
   *  `pinned`, nothing else moves. */
  pin?: (day: string) => void;
  /** SELECT MODE'S HOTSPOT — present only while the toolbar's Select toggle
   *  is up, and a SEPARATE control from the close checkbox so the one-gesture
   *  close (§9.2) never gains a second meaning. Gathers; writes nothing. */
  select?: { selected: boolean; toggle: (shiftKey: boolean) => void };
  /**
   * §13.8 (2026-08-19), "rows edit in place" — ONLY passed by call sites
   * where `title` is verifiably `SpoolItem.title` and not a thread-derived
   * or synthesized string (the "Waiting its turn" rows). Absent everywhere
   * else in this file: `needs`/`settled`/proposal rows render thread text as
   * `title`, and wiring inline edit there would silently rewrite the wrong
   * field.
   */
  onEditTitle?: (next: string) => Promise<void>;
  /** §13.8's inset lane/pin/tag panel — same title-safety gate as `onEditTitle`. */
  disclose?: { lane?: string; lanes: SpoolLane[]; tags: string[]; pinnedDay?: string; onLane: (lane: string) => void; onPin: (day: string | null) => void; onTags: (tags: string[]) => void };
}) {
  /* THE THREE TEXT LEVELS, applied here and everywhere in the room:
     TITLES — the user's words — text-sm, foreground, font-medium;
     META — attribution and detail — text-xs, muted-foreground;
     SECTION HEADERS carry the small-caps register one tone up from meta. */
  const body = (
    <span className="min-w-0 flex-1">
      {onEditTitle ? (
        <EditableTitle text={said ?? title} onCommit={onEditTitle} />
      ) : (
        <span className="block min-w-0 truncate text-sm leading-relaxed font-medium text-foreground">{said ?? title}</span>
      )}
      {meta && <span className="block min-w-0 truncate text-xs leading-relaxed text-muted-foreground">{meta}</span>}
    </span>
  );
  return (
    /* A REAL LIST ROW: hairline between neighbours, comfortable padding, a
       hover surface and a quiet chevron saying the row opens somewhere. The
       row is a DIV now, not one big button: the checkbox and the hover verbs
       are their own controls, and controls do not nest. */
    <li className="border-b border-border/40 last:border-b-0">
      {itemId && onOpen ? (
        <RowContextMenu itemId={itemId} onOpen={onOpen} said={said} title={title} {...(close ? { close } : {})} {...(pin ? { pin } : {})}>
          <div className="group flex w-full items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted/60 focus-within:bg-muted/60">
            {select && (
              <SelectHotspot
                selected={select.selected}
                label={`Select “${clip(said ?? title, 40)}”`}
                onToggle={select.toggle}
              />
            )}
            {close && <CloseCheckbox closed={false} label={`Close “${clip(said ?? title, 40)}”`} onToggle={close} />}
            {/* onEditTitle's `EditableTitle` is its own click target (title
                click opens a text field), so this wraps in a DIV rather than
                `Row`'s ordinary <button>: a real <button> cannot contain
                another interactive control. */}
            {onEditTitle ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => onOpen(itemId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(itemId);
                }}
                title="Open the packet"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onOpen(itemId)}
                title="Open the packet"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </button>
            )}
            <RowVerbs {...(pin ? { pin } : {})} {...(onSettle && !confront ? { onSettle } : {})} />
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground" aria-hidden />
          </div>
        </RowContextMenu>
      ) : (
        <div className="group flex w-full items-center gap-2 px-3 py-2">
          {body}
          {onSettle && !confront && <RowVerbs onSettle={onSettle} />}
        </div>
      )}
      {confront && <ConfrontLine confront={confront} {...(onSettle ? { onSettle } : {})} />}
      {disclose && <RowDisclosure {...disclose} />}
    </li>
  );
}

/**
 * THE TASK ROW'S OWN CONTEXT MENU — §9.4's parity rule read the other way:
 * every verb the row's hover controls already carry gets a right-click twin,
 * never a new one. "Close" fires the SAME `close` callback the checkbox's
 * `onToggle` fires (`onCloseItem` → `closeItemByHand`, `lib/spool-close.ts` —
 * the one dedicated route, never the generic items PATCH); "Pin to a day"
 * reuses the SAME `pin` callback `RowVerbs`' native date input already
 * fires; "Open packet" is the SAME `onOpen(itemId)` the row's own button
 * fires. OMITTED, and named here rather than faked: "Move to lane…" and
 * "Tag…" — no per-row callback reaches THIS MENU for either (only the Tasks
 * tab's bulk selection bar, `laneSelected`/`tagSelected` in `room.tsx`, can
 * move a lane or set a tag through a right-click, and both operate on a
 * multi-id selection, not a single row). "Reopen" is not offered here
 * because `Row` only ever renders ACTIVE items (its `CloseCheckbox` is
 * hardcoded `closed={false}`); the closed twin lives on `DoneShelf`'s own
 * rows below, with its own menu.
 *
 * UPDATED 2026-08-19, §13.8: `Row`'s own `disclose` prop now DOES reach a
 * per-row lane/pin/tag editor — on the row itself, behind the quiet chevron
 * (`RowDisclosure`, `task-row.tsx`), not through this menu. The omission
 * above is scoped to the CONTEXT MENU specifically; a right-click still only
 * offers Close, Pin to…, and Open packet, on purpose — this menu stays the
 * hover-verb twins, and the disclosure is where the fuller editor lives.
 */
function RowContextMenu({
  itemId,
  onOpen,
  said,
  title,
  close,
  pin,
  children,
}: {
  itemId: string;
  onOpen: (id: string) => void;
  said?: string;
  title: string;
  close?: () => void;
  pin?: (day: string) => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {close && <ContextMenuItem onClick={close}>Close</ContextMenuItem>}
        {pin && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Pin to…</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <label className="flex items-center gap-1.5 px-1.5 py-1 text-sm">
                <input
                  type="date"
                  aria-label={`Pin “${clip(said ?? title, 40)}” to a day`}
                  onChange={(event) => {
                    const day = event.currentTarget.value;
                    if (day) pin(day);
                  }}
                  className="h-6 w-[8rem] rounded-md border border-border bg-transparent px-1.5 text-xs text-muted-foreground outline-none"
                />
              </label>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {(close || pin) && <ContextMenuSeparator />}
        <ContextMenuItem onClick={() => onOpen(itemId)}>Open packet</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * THE ROW'S RIGHT RAIL — §9.4, the parity rule: "the room's verbs live on the
 * rows where a person looks for them, not only inside trays." Revealed on
 * hover or focus in the chevron area, sized like the room's other quiet
 * controls. `Settle…` only SUMMONS the dialog (the one settle write stays the
 * dialog's confirm); the date input PATCHes the pin and nothing else — a
 * native input because a date the hand picks is a date the hand stated. When
 * the claim is confronted, the ConfrontLine under the row already teaches
 * Settle, so the rail stays out of its way.
 */
function RowVerbs({ pin, onSettle }: { pin?: (day: string) => void; onSettle?: () => void }) {
  if (!pin && !onSettle) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      {onSettle && (
        <button
          type="button"
          onClick={onSettle}
          title="Record what happened — the thread stays, settled, with the answer"
          className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
        >
          Settle…
        </button>
      )}
      {pin && (
        <input
          type="date"
          aria-label="Pin to a day"
          title="Pin to a day — your own date, stated by hand"
          onChange={(event) => {
            const day = event.currentTarget.value;
            if (day) pin(day);
          }}
          className="h-6 w-[7.5rem] rounded-md border border-border bg-transparent px-1.5 text-3xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
    </span>
  );
}

/**
 * THE WORLD'S WORD, UNDER THE CLAIM. The sentence quotes the observation's
 * STORED text and seen label — nothing composed, nothing computed, no urgency
 * vocabulary and no colour: "may have moved past" is a possibility the human
 * judges, not an alarm. The one verb it can carry OPENS the settle dialog;
 * a claim with no thread renders the annotation alone.
 */
function ConfrontLine({ confront, onSettle }: { confront: { text: string; seen: string }; onSettle?: () => void }) {
  return (
    <div className="flex min-w-0 items-start gap-2 px-3 pb-2">
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
        the world may have moved past this — {confront.text} (seen {confront.seen})
      </p>
      {onSettle && (
        <button
          type="button"
          onClick={onSettle}
          title="Record what happened — the thread stays, settled, with the answer"
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
        >
          Settle — record what happened
        </button>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground/70">{children}</p>;
}

/**
 * A BAND NAMES WHOSE HANDS THE WORK IS IN. The mark on "Needs you" is one of
 * `--spool`'s five sanctioned places — the single dot that says which band is
 * yours before you have read a word. No other band carries one. The hairline
 * under each header is what gives the page strata: four regions you can see
 * from across the room, not one continuous list.
 */
function Band({ mark, title, aside, children }: { mark?: boolean; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      {/* SECTION-HEADER LEVEL: the small-caps register with real presence —
          text-xs, semibold, full muted-foreground — a clear tone above meta. */}
      <h2 className="flex items-center gap-2 border-b border-border/70 px-3 pb-2 text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {mark && <span className="size-1.5 shrink-0 rounded-full bg-spool" aria-hidden />}
        {title}
        {aside}
      </h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/**
 * FRESHNESS, QUOTED — the trust line of loops §4. `lastLooked` is the store's
 * own label ("looked Sat 13:24"), quoted verbatim with attribution; nothing
 * here reads a clock or computes an age. A reconcile in flight shows the
 * quiet pulse; one that failed says so in words — no red, no badge — with the
 * stale label as the honest bound on what is known.
 */
function FreshnessLine({ look, looking }: { look: SubjectLook; looking: boolean }) {
  if (!look.hasTerrain) return null;
  const moved = look.moved.length;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {looking && <Loader2Icon className="size-3 shrink-0 animate-spin text-spool" aria-hidden />}
      <span className="min-w-0 truncate">
        {look.error
          ? `couldn't look: ${look.error}${look.lastLooked ? ` — stale since ${look.lastLooked}` : ""}`
          : look.lastLooked
            ? `${look.lastLooked}${moved > 0 ? ` · ${moved} ${moved === 1 ? "thing" : "things"} moved` : ""}`
            : "never looked yet"}
      </span>
    </span>
  );
}

/**
 * ONE THING THAT MOVED, in the observation's own words — a world fact beside
 * the subject it is about, never a fifth band and never a Needs-you entry.
 * AT MOST TWO VERBS (loops §5): one that opens work — the packet, when a ref
 * maps to one; the subject's face otherwise — and "Noted", which DRAINS the
 * observation through the ack route. Nothing deletes.
 */
function ObservationLine({
  line,
  subject,
  onOpen,
  onSubject,
  onAck,
}: {
  line: MovedLine;
  subject: string;
  onOpen: (id: string) => void;
  onSubject: (key: string | null) => void;
  onAck: (subject: string, observationId: string) => void;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">{line.observation.text}</span>
      <button
        type="button"
        onClick={() => (line.itemId ? onOpen(line.itemId) : onSubject(subject))}
        title={line.itemId ? "Open the packet this touches" : `Everything filed to ${subject}`}
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
      >
        Open
      </button>
      <button
        type="button"
        onClick={() => onAck(subject, line.observation.id)}
        title="Noted — it stays in the record, marked"
        className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
      >
        Noted
      </button>
    </li>
  );
}

/**
 * THE DIGEST REPLACES THE FLOOD — loops §10's volume work, compress-never-
 * multiply applied to movement. The ENGINE composes one line per lane-group
 * ("Hito 1 · Agosto — 8 PRs merged, 7 issues closed", the residual per-
 * subject line last) and this renders those lines VERBATIM: nothing here
 * counts, groups or re-words, so the digest a session reads and the one the
 * room shows cannot disagree.
 *
 * EACH LINE EXPANDS to the observations it stands for — the same
 * `ObservationLine`, same two verbs, nothing re-spelled — and carries ONE
 * verb of its own: "Noted all", which drains the whole group through the
 * BULK ack route in one request. Never a loop over the single route: the
 * engine marks the group atomically, and a loop that died halfway would
 * leave a half-noted group no record explains.
 */
function MovementDigest({
  look,
  subject,
  onOpen,
  onSubject,
  onAck,
  onAckAll,
}: {
  look: SubjectLook;
  subject: string;
  onOpen: (id: string) => void;
  onSubject: (key: string | null) => void;
  onAck: (subject: string, observationId: string) => void;
  /** "Noted all" — the bulk drain, one POST for the group's own ids. */
  onAckAll: (subject: string, observationIds: string[]) => void;
}) {
  /** Which digest line is expanded — one at a time, keyed by its text: the
   *  lines are the engine's own and distinct by construction. */
  const [openLine, setOpenLine] = useState<string | null>(null);
  if (look.digest.length === 0) return null;
  const byId = new Map(look.moved.map((m) => [m.observation.id, m]));
  return (
    <ul className="pb-1">
      {look.digest.map((group) => {
        const expanded = openLine === group.text;
        const lines = group.observationIds
          .map((id) => byId.get(id))
          .filter((m): m is MovedLine => !!m);
        return (
          <li key={group.text}>
            <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenLine(expanded ? null : group.text)}
                title="What this line stands for, in the observations' own words"
                className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRightIcon
                  className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-xs leading-relaxed text-foreground">{group.text}</span>
              </button>
              <button
                type="button"
                onClick={() => onAckAll(subject, group.observationIds)}
                title="Noted, all of these — they stay in the record, marked"
                className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
              >
                Noted all
              </button>
            </div>
            {expanded && (
              <ul className="pl-4">
                {lines.map((m) => (
                  <ObservationLine
                    key={m.observation.id}
                    line={m}
                    subject={subject}
                    onOpen={onOpen}
                    onSubject={onSubject}
                    onAck={onAck}
                  />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * ONE LINE PER SUBJECT — the wide view's whole unit, loops §6: wide is for
 * CHOOSING, so a subject compresses to its name, whose turn it is there in
 * counts, and its freshness — never its items. The NAME narrows the aperture
 * (choosing IS focusing); the COUNTS summon the subject's filed items into
 * the tray, so the capability set stays whole without focusing first; the
 * shield opens the grants. What moved renders under the line, in the
 * observations' own words — movement about a subject belongs with the
 * subject.
 */
function SubjectLine({
  line,
  looking,
  onScope,
  onPermits,
  onSubject,
  onOpen,
  onAck,
  onAckAll,
}: {
  line: SubjectLineModel;
  looking: boolean;
  onScope: (subject: string) => void;
  onPermits: () => void;
  onSubject: (key: string | null) => void;
  onOpen: (id: string) => void;
  onAck: (subject: string, observationId: string) => void;
  onAckAll: (subject: string, observationIds: string[]) => void;
}) {
  const claims = [
    line.needs > 0 ? `${line.needs} need${line.needs === 1 ? "s" : ""} you` : "nothing needs you",
    ...(line.look.moved.length > 0 ? [`${line.look.moved.length} moved`] : []),
    ...(line.withAgent > 0 ? [`${line.withAgent} with the agent`] : []),
    ...(line.onPerson > 0 ? [`${line.onPerson} on others`] : []),
  ].join(", ");
  return (
    /* A real list row like `Row`: hairline between neighbours, padding, and a
       hover surface on the whole line so the two click targets read as live. */
    <li className="border-b border-border/40 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted/40">
        {/* WHOSE this line is — the identity dot, constant whatever the counts
            beside it say. Neutral grey when no colour was chosen. */}
        <SubjectDot color={line.color} />
        <button
          type="button"
          onClick={() => onScope(line.subject)}
          title={`Focus the room on ${line.subject}`}
          className="shrink-0 rounded-sm text-sm font-medium text-foreground outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {line.subject}
        </button>
        <button
          type="button"
          onClick={() => onSubject(line.subject)}
          title={`Everything filed to ${line.subject}`}
          className="min-w-0 flex-1 truncate rounded-sm text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {claims}
        </button>
        <FreshnessLine look={line.look} looking={looking} />
        <button
          type="button"
          onClick={onPermits}
          aria-label={`Permits for ${line.subject}`}
          title={`What the night may do for ${line.subject}`}
          className="shrink-0 rounded-sm text-muted-foreground/40 transition-colors hover:text-foreground"
        >
          <ShieldIcon className="size-3" />
        </button>
      </div>
      {/* Movement under the line, wide — DIGESTED (loops §10): the engine's
          one-line-per-group compression, each expandable to its observations,
          never the flood painted first. */}
      {line.look.digest.length > 0 && (
        <div className="pl-4">
          <MovementDigest
            look={line.look}
            subject={line.subject}
            onOpen={onOpen}
            onSubject={onSubject}
            onAck={onAck}
            onAckAll={onAckAll}
          />
        </div>
      )}
    </li>
  );
}

/**
 * THE ONE FOCAL POINT. The band's first entry gets card treatment — the raw
 * words a touch larger, the subject, and WHY it is first, composed from fields
 * the record already carries. Its words summon the tray; its chat verb
 * prefills the composer and the human presses send.
 */
function FocalCard({
  entry,
  onOpen,
  onSuggest,
  onSettle,
  onClose,
}: {
  entry: NeedEntry;
  onOpen: (id: string) => void;
  onSuggest: (text: string) => void;
  /** The settle dialog's opener — any thread-backed claim's, §9.4, not only a
   *  confronted one's. Same verb the plain rows teach, same one write path. */
  onSettle?: () => void;
  /** The checkbox, §9.1 — the focal card is still an item-backed row, and the
   *  hand's close is not outranked by prominence. */
  onClose?: () => void;
}) {
  const words = (
    <>
      <span className="block text-base leading-snug font-medium text-foreground">{clip(entry.said ?? entry.title, 140)}</span>
      <span className="mt-1.5 flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">{entry.subject}</span>
        {entry.why && <span className="min-w-0 truncate text-xs text-muted-foreground/80">{entry.why}</span>}
      </span>
    </>
  );
  return (
    /* The focal INSET: the stance's content now stands on its own card sheet,
       so the one focal point steps DOWN from the sheet — a quiet tinted well
       with a hairline — rather than stacking card-on-card, which reads as no
       elevation at all in light mode. */
    <div className="mb-2 rounded-lg bg-muted/40 px-3.5 py-3 ring-1 ring-border/60">
      {entry.itemId ? (
        <div className="flex items-start gap-2.5">
          {onClose && (
            <CloseCheckbox
              closed={false}
              label={`Close “${clip(entry.said ?? entry.title, 40)}”`}
              onToggle={onClose}
              className="mt-1"
            />
          )}
          <button
            type="button"
            onClick={() => onOpen(entry.itemId!)}
            className="block min-w-0 flex-1 text-left outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {words}
          </button>
        </div>
      ) : (
        <div>{words}</div>
      )}
      {entry.questions && entry.questions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {entry.questions.map((question) => (
            <li key={question} className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
              {question}
            </li>
          ))}
        </ul>
      )}
      {entry.confront && (
        <div className="mt-2 -mb-1 -ml-3">
          <ConfrontLine confront={entry.confront} {...(onSettle ? { onSettle } : {})} />
        </div>
      )}
      {(entry.ask || (onSettle && !entry.confront)) && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {entry.ask && (
            <button
              type="button"
              onClick={() => onSuggest(entry.ask!)}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
            >
              Answer in chat
            </button>
          )}
          {/* The hand's Settle, §9.4 — on the card whenever a thread backs it;
              the confronted case already teaches it on the ConfrontLine above. */}
          {onSettle && !entry.confront && (
            <button
              type="button"
              onClick={onSettle}
              title="Record what happened — the thread stays, settled, with the answer"
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
            >
              Settle…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * FILING, FOLDED TO ONE LINE. Expands in place; its chat verb prefills the
 * filing message rather than sending it — the capability is shown, the human
 * keeps the last word.
 */
function HousekeepingFold({
  lines,
  onOpen,
  onSubject,
  onSuggest,
  onClose,
  onPin,
}: {
  lines: HousekeepingLine[];
  onOpen: (id: string) => void;
  /** The unfiled pseudo-subject in the tray — the fold is its door. */
  onSubject: (key: string | null) => void;
  onSuggest: (text: string) => void;
  /** §9.1/§9.4 — a chore row is still an item-backed row: it closes and pins
   *  by hand like every other. */
  onClose: (id: string) => void;
  onPin: (id: string, day: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 border-t border-border/40 pt-1">
      <div className="flex min-w-0 items-center gap-1 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          {lines.length === 1 ? "1 thing needs filing" : `${lines.length} things need filing`}
        </button>
        <button
          type="button"
          onClick={() => onSuggest("File everything that's unfiled where it belongs.")}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
        >
          File them in chat
        </button>
      </div>
      {open && (
        <>
          <ul>
            {lines.map((line) => (
              <Row
                key={line.id}
                {...(line.said ? { said: line.said } : {})}
                title={line.title}
                itemId={line.id}
                onOpen={onOpen}
                close={() => onClose(line.id)}
                pin={(day) => onPin(line.id, day)}
              />
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onSubject(null)}
            className="px-3 py-1 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            Everything unfiled, in the tray
          </button>
        </>
      )}
    </div>
  );
}

/** The fold line — what the aperture is not showing, said honestly. Clicking
 *  it widens, which is the smallest possible way back. */
function FoldedLine({ folded, onWiden }: { folded: FoldedSubject[]; onWiden: () => void }) {
  if (folded.length === 0) return null;
  const blocked = folded.filter((f) => f.blocking > 0);
  /** The MEANWHILE periphery, loops §6: a week of focus must not let the
   *  others quietly die, so movement in a folded subject is named — a world
   *  fact, one glance away, never a claim on the user. */
  const movement = folded.filter((f) => f.blocking === 0 && f.moved > 0).map((f) => f.subject);
  const calm = folded.filter((f) => f.blocking === 0 && f.moved === 0).map((f) => f.subject);
  const parts: string[] = [
    ...blocked.map((f) => `${f.subject} has ${f.blocking} ${f.blocking === 1 ? "thing" : "things"} waiting`),
    ...(movement.length > 0 ? [`meanwhile: movement in ${movement.join(" and ")}`] : []),
    ...(calm.length > 0
      ? [`${calm.join(" and ")} ${calm.length === 1 ? "is" : "are"} folded — nothing in ${calm.length === 1 ? "it" : "them"} blocks you`]
      : []),
  ];
  return (
    <button
      type="button"
      onClick={onWiden}
      className="mt-2 block w-full rounded-lg border border-dashed border-border px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
    >
      {parts.join("; ")}
    </button>
  );
}

/**
 * THE DONE SHELF — §9.3: "closed items leave the active desk into a visible
 * Done shelf." A FOLD, DELIBERATELY NOT A FIFTH BAND: the band register stays
 * the four arrival questions (Needs you / In its hands / Waiting on others /
 * Settled — whose turn is it), and "done" is not a turn, it is the record of
 * turns that ended. So this renders below the Settled region as a quiet fold,
 * the same grammar as the housekeeping fold.
 *
 * DRAINS, NEVER DELETES. Every row keeps its ticked checkbox — unticking is
 * the reopen, one gesture, no dialog, from every place a closed item renders
 * — and quotes the store's own closed label ("closed Tue 16:42"), never a
 * time this code computed. Dimmed, not struck through everywhere: the words
 * are still the user's own.
 */
function DoneShelf({
  rows,
  onOpen,
  onReopen,
  select,
}: {
  rows: DoneRow[];
  onOpen: (id: string) => void;
  onReopen: (id: string) => void;
  /** Select mode reaches the shelf too — closing was the hand's, and so is
   *  gathering what it closed. Gathers; writes nothing. */
  select?: { selected: (id: string) => boolean; toggle: (id: string, shiftKey: boolean) => void };
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="mb-10 border-t border-border/40 pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        Done — {rows.length}
      </button>
      {open && (
        <>
          <ul>
            {rows.map((row) => (
              <li key={row.id} className="border-b border-border/40 last:border-b-0">
                {/* THE CLOSED TWIN of `RowContextMenu` above — "Reopen" fires the SAME
                    `onReopen` the unticked checkbox already fires (`reopenByHand` →
                    `reopenItemByHand`, the one dedicated route); "Open packet" is the
                    SAME `onOpen(row.id)` the row's own button fires. */}
                <ContextMenu>
                  <ContextMenuTrigger>
                    <div className="group flex w-full items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted/40">
                      {select && (
                        <SelectHotspot
                          selected={select.selected(row.id)}
                          label={`Select “${clip(row.said ?? row.title, 40)}”`}
                          onToggle={(shiftKey) => select.toggle(row.id, shiftKey)}
                        />
                      )}
                      <CloseCheckbox
                        closed
                        label={`Reopen “${clip(row.said ?? row.title, 40)}”`}
                        onToggle={() => onReopen(row.id)}
                      />
                      <button
                        type="button"
                        onClick={() => onOpen(row.id)}
                        title="Open the packet"
                        className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block min-w-0 truncate text-sm leading-relaxed font-medium text-muted-foreground/60">
                          {row.said ?? row.title}
                        </span>
                        <span className="block min-w-0 truncate text-xs leading-relaxed text-muted-foreground/60">
                          {row.subject} — “closed {row.closedLabel}”
                        </span>
                      </button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onReopen(row.id)}>Reopen</ContextMenuItem>
                    <ContextMenuItem onClick={() => onOpen(row.id)}>Open packet</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            ))}
          </ul>
          <p className="px-3 pt-1.5 text-3xs leading-relaxed text-muted-foreground/60">
            Closed drains here and never deletes — untick a box to reopen. The count below still holds every one.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * THE MORNING REPORT, drawn from `night.json` with no model call. A running
 * night's pending jobs ARE tonight's plan — §11.3: frozen when the night
 * started, shown as an audit trail beside what came of it, and never as a
 * consent screen. Its heading summons the full record into the tray. One
 * component because both apertures render it — the report is arrival's news,
 * wide or focused.
 */
function NightCard({
  night,
  onNight,
  onOpenItem,
}: {
  night: SpoolNight;
  onNight: () => void;
  onOpenItem: (id: string) => void;
}) {
  return (
    /* An inset well, like the focal card — the stance stands on its own sheet
       now, so what used to be card-on-canvas becomes a tinted step down. */
    <div className="mb-3 rounded-lg bg-muted/40 px-3 py-2.5 ring-1 ring-border/60">
      <button
        type="button"
        onClick={onNight}
        className="block w-full text-left text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {night.state === "running" ? `Tonight · ${night.opened}` : `Last night · ${night.opened}`}
      </button>
      <ul className="mt-1.5 space-y-0.5">
        {night.jobs.map((job) => {
          const mark = JOB_MARK[job.state];
          const body = (
            <>
              <mark.Icon className={cn("mt-0.5 size-3.5 shrink-0", mark.tone)} aria-label={mark.label} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{job.title}</span>
                {job.note && (
                  <span className="block truncate text-xs leading-relaxed text-muted-foreground">
                    {job.note}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={job.id}>
              {job.itemId ? (
                <button
                  type="button"
                  onClick={() => onOpenItem(job.itemId!)}
                  className="flex w-full min-w-0 items-start gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {body}
                </button>
              ) : (
                <div className="flex w-full min-w-0 items-start gap-2 px-1 py-1">{body}</div>
              )}
            </li>
          );
        })}
        {night.jobs.length === 0 && (
          <li className="px-1 text-xs text-muted-foreground/60">It found nothing that needed doing.</li>
        )}
      </ul>
      {night.stop && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{night.stop.note}</p>
      )}
      {night.usage?.costUsd !== undefined && (
        <p className="mt-1 font-mono text-3xs text-muted-foreground/60 tabular-nums">
          ${night.usage.costUsd.toFixed(2)}
        </p>
      )}
    </div>
  );
}

/** A PASS IN FLIGHT — the pulse is `--spool`'s other sanctioned place on this
 *  screen. Stoppable, because it spends money. Both apertures render it: a
 *  running pass is the one thing neither view may hide. */
function RunningPasses({ work }: { work: SpoolWorkView }) {
  if (work.running.length === 0) return null;
  return (
    <ul>
      {work.running.map((entry) => (
        <li key={entry.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
          <Loader2Icon className="size-3 shrink-0 animate-spin text-spool" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{entry.itemTitle}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {describeWork(entry)}
              {entry.origin === "night" && " · overnight"}
            </span>
          </span>
          <button
            type="button"
            onClick={() => work.cancel(entry.id)}
            className="shrink-0 text-muted-foreground/40 transition-colors hover:text-foreground"
            aria-label={`Stop ${entry.itemTitle}`}
            title="Stop — nothing will be written"
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * THE TWO SMART SCOPES — loops §8.3, Reminders' Today and Scheduled.
 *
 * APERTURES, NOT ROUTES (§6's laws apply whole): both are states of the one
 * room — same bands' grammar, same tray summons, same chat next door, no href
 * anywhere. And apertures, NOT FOCUS COMMITMENTS: neither ever writes the
 * engine's focus store. The focus log records SUBJECT focus only — "you're on
 * ozom-gv" is a fact about where your attention went that the chat's pickup
 * quotes back later, and "you glanced at today" is not that kind of fact;
 * recording it would teach the pickup to say you were working on a view.
 * So they live in component state, and leaving is the same "Show everything"
 * affordance the subject aperture teaches. The chat cannot SET them yet — no
 * tool names them — but every turn is told when one is up (`scope=today`),
 * so what the model reads matches what the human sees.
 */
/**
 * SETTLE-ALL-ANSWERED — loops §10's volume work on the confrontation join.
 * Where the world has already answered claims (an unacknowledged observation
 * met its stuck-on-you thread), ONE quiet control above the claims offers to
 * settle them together. It only SUMMONS the one dialog — the prefilled
 * answers are shown there, and only its confirm sends, through the BULK
 * settle route. Never auto: the system composes nothing and settles nothing
 * on its own.
 */
function SettleAnswered({ entries, onSettleAll }: { entries: NeedEntry[]; onSettleAll: (entries: NeedEntry[]) => void }) {
  if (entries.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => onSettleAll(entries)}
      className="mb-1 block w-full rounded-md border border-dashed border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
    >
      The world answered {entries.length} of these — settle them all
    </button>
  );
}

/** The confronted, thread-backed slice of Needs you — what Settle-all can
 *  honestly offer: a claim with no thread has nothing to settle, and one the
 *  world has not answered has no prefill that is not an invention. */
function answeredOf(needs: NeedEntry[]): NeedEntry[] {
  return needs.filter((e) => e.threadId && e.confront);
}

export function TodayScope({
  model,
  onOpenItem,
  onSuggest,
  onSettle,
  onSettleAll,
  onCloseItem,
  onPinItem,
  selectProps,
}: {
  model: StanceModel;
  onOpenItem: (id: string) => void;
  onSuggest: (text: string) => void;
  /** Opens the settle dialog — gated per entry on the thread existing,
   *  because a prepared card has nothing to settle. Confronted or not: §9.4
   *  made Settle always the hand's on a thread-backed claim. */
  onSettle: (entry: SettleTarget) => void;
  onSettleAll: (entries: NeedEntry[]) => void;
  /** §9.1's checkbox and §9.4's Pin…, wired down to every item-backed row. */
  onCloseItem: (id: string) => void;
  onPinItem: (id: string, day: string) => void;
  /** Select mode's per-row props, composed by the room. Empty when off. */
  selectProps: (id?: string) => { select?: { selected: boolean; toggle: (shiftKey: boolean) => void } };
}) {
  /**
   * ACROSS ALL SUBJECTS: what needs you plus what you pinned to today — and
   * the derivation already made that one list, because a pin whose day has
   * come joins `needs` at tier 2 (via the sanctioned today-helper, in the
   * user's own voice). This scope is that list, flat and uncapped: the
   * morning glance chose to see all of it, and each row names its subject
   * because eight lives share the page.
   */
  const [focal, ...rest] = model.needs;
  return (
    <Band mark title="Needs you">
      {model.needs.length === 0 && <Empty>Nothing needs you, and nothing is pinned to today.</Empty>}
      {focal && (
        <FocalCard
          entry={focal}
          onOpen={onOpenItem}
          onSuggest={onSuggest}
          {...(focal.threadId ? { onSettle: () => onSettle(focal) } : {})}
          {...(focal.itemId ? { onClose: () => onCloseItem(focal.itemId!) } : {})}
        />
      )}
      <SettleAnswered entries={answeredOf(model.needs)} onSettleAll={onSettleAll} />
      <ul>
        {rest.map((entry) => (
          <Row
            key={entry.key}
            {...(entry.said ? { said: entry.said } : {})}
            title={entry.title}
            meta={clip(`${entry.subject}${entry.meta ? ` — ${entry.meta}` : ""}`)}
            {...(entry.itemId ? { itemId: entry.itemId } : {})}
            onOpen={onOpenItem}
            {...(entry.confront ? { confront: entry.confront } : {})}
            {...(entry.threadId ? { onSettle: () => onSettle(entry) } : {})}
            {...(entry.itemId ? { close: () => onCloseItem(entry.itemId!), pin: (day: string) => onPinItem(entry.itemId!, day) } : {})}
            {...selectProps(entry.itemId)}
          />
        ))}
      </ul>
    </Band>
  );
}

/** One Scheduled row — checkbox, dot, words, subject; the packet summons like
 *  every line in the room. The dot is identity riding along, never a status,
 *  and the checkbox (§9.1) is the same shared control as everywhere. */
function ScheduledLine({
  row,
  meta,
  onOpen,
  onClose,
  select,
  onEditTitle,
  disclose,
}: {
  row: ScheduledRow;
  meta?: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  /** Select mode's hotspot — same law as `Row`'s: gathers, writes nothing. */
  select?: { selected: boolean; toggle: (shiftKey: boolean) => void };
  /** §13.8 (2026-08-19) — safe here because `row.title` is always
   *  `SpoolItem.title` (see `deriveStance`'s `pinnedAll`), unlike some of
   *  `Row`'s other call sites. */
  onEditTitle?: (next: string) => Promise<void>;
  disclose?: { lane?: string; lanes: SpoolLane[]; tags: string[]; pinnedDay?: string; onLane: (lane: string) => void; onPin: (day: string | null) => void; onTags: (tags: string[]) => void };
}) {
  const body = (
    <span className="min-w-0 flex-1">
      {onEditTitle ? (
        <EditableTitle text={row.said ?? row.title} onCommit={onEditTitle} />
      ) : (
        <span className="block truncate text-sm leading-relaxed font-medium text-foreground">{row.said ?? row.title}</span>
      )}
      <span className="block truncate text-xs leading-relaxed text-muted-foreground">{meta ?? row.subject}</span>
    </span>
  );
  return (
    <li className="border-b border-border/40 last:border-b-0">
      <div className="group flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted/60 focus-within:bg-muted/60">
        {select && (
          <SelectHotspot
            selected={select.selected}
            label={`Select “${clip(row.said ?? row.title, 40)}”`}
            onToggle={select.toggle}
          />
        )}
        <CloseCheckbox
          closed={false}
          label={`Close “${clip(row.said ?? row.title, 40)}”`}
          onToggle={() => onClose(row.id)}
        />
        <SubjectDot color={row.color} />
        {/* Same button-cannot-nest-a-control reason as `Row`'s onEditTitle branch. */}
        {onEditTitle ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => onOpen(row.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpen(row.id);
            }}
            title="Open the packet"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(row.id)}
            title="Open the packet"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </button>
        )}
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground" aria-hidden />
      </div>
      {disclose && <RowDisclosure {...disclose} />}
    </li>
  );
}

export function ScheduledScope({
  scheduled,
  onOpenItem,
  onCloseItem,
  selectProps,
  lanes,
  onEditItem,
}: {
  scheduled: StanceModel["scheduled"];
  onOpenItem: (id: string) => void;
  onCloseItem: (id: string) => void;
  selectProps: (id?: string) => { select?: { selected: boolean; toggle: (shiftKey: boolean) => void } };
  /** §13.8 (2026-08-19) — the shared row grammar's lane list and edit sink,
   *  optional so existing callers (none yet outside `Stance` itself) are not
   *  forced to wire them; absent means every row falls back to its old,
   *  read-only rendering. */
  lanes?: SpoolLane[];
  onEditItem?: (id: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const rowEdit = (row: ScheduledRow) =>
    onEditItem
      ? {
          onEditTitle: (next: string) => onEditItem(row.id, { title: next }),
          disclose: {
            ...(row.lane ? { lane: row.lane } : {}),
            lanes: lanes ?? [],
            tags: row.tags,
            pinnedDay: row.day,
            onLane: (lane: string) => void onEditItem(row.id, { lane }),
            onPin: (day: string | null) => void onEditItem(row.id, { pinned: day ? { day } : null }),
            onTags: (tags: string[]) => void onEditItem(row.id, { tags }),
          },
        }
      : {};
  return (
    <Band title="Scheduled">
      {scheduled.slipped.length === 0 && scheduled.days.length === 0 && (
        <Empty>Nothing is pinned to a day. Pin something on the calendar, or from a packet.</Empty>
      )}
      {/* SLIPPED PINS FIRST, under their honest sentence — recorded, never
          punished: the same quiet voice as the calendar's strip, no red, no
          count of days, and the dot stays whatever hue the subject wears. */}
      {scheduled.slipped.length > 0 && (
        <div>
          <p className="px-3 pt-2 pb-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            pinned to days that have passed — still here
          </p>
          <ul>
            {scheduled.slipped.map((row) => (
              <ScheduledLine
                key={row.id}
                row={row}
                meta={`${row.subject} — you pinned this to ${formatDay(row.day)}`}
                onOpen={onOpenItem}
                onClose={onCloseItem}
                {...selectProps(row.id)}
                {...rowEdit(row)}
              />
            ))}
          </ul>
        </div>
      )}
      {/* Day order, headed by the day itself — `formatDay`'s pure format of a
          date the user stated ("Tue 18 Aug"), quoted, never computed from. */}
      {scheduled.days.map((group) => (
        <div key={group.day}>
          <p className="px-3 pt-3 pb-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            {formatDay(group.day)}
          </p>
          <ul>
            {group.rows.map((row) => (
              <ScheduledLine
                key={row.id}
                row={row}
                onOpen={onOpenItem}
                onClose={onCloseItem}
                {...selectProps(row.id)}
                {...rowEdit(row)}
              />
            ))}
          </ul>
        </div>
      ))}
    </Band>
  );
}

export function Stance({
  model,
  work,
  totals,
  looking,
  smart,
  onSmart,
  onOpenItem,
  onNight,
  onPermits,
  onSubject,
  onScope,
  onWiden,
  onSuggest,
  onAck,
  onAckAll,
  onSettle,
  onSettleAll,
  onCloseItem,
  onReopenItem,
  onPinItem,
  closeNote,
  bulkNote,
  selection,
  embedded,
  lanes,
  onEditItem,
}: {
  model: StanceModel;
  work: SpoolWorkView;
  /** The smart scope that is up, if any — a VIEW aperture read from the
   *  shared slot (see `SpoolStance` for why it never touches the focus
   *  store). Only shown while unfocused: subject focus is the deeper
   *  aperture and covers it without clearing it. */
  smart: "today" | "scheduled" | null;
  onSmart: (scope: "today" | "scheduled" | null) => void;
  /** The store's own honesty lines, inherited from the retired queue: the
   *  conservation counts and the rows a tolerant read had to skip. */
  totals: { totalItems: number; agentsAdded: number; unreadable: SpoolUnreadable[] } | null;
  /** Subjects whose reconcile is in flight right now — the quiet pulse beside
   *  their freshness line, never a blocker on paint. */
  looking: string[];
  onOpenItem: (id: string) => void;
  onNight: () => void;
  onPermits: () => void;
  /** A subject's filed items, as a tray face. `null` is the unfiled
   *  pseudo-subject — floating stays a rendering of absence. */
  onSubject: (key: string | null) => void;
  onScope: (subject: string) => void;
  onWiden: () => void;
  /** Prefill the composer next door — the wiring behind every chat verb a
   *  line teaches. Never sends. */
  onSuggest: (text: string) => void;
  /** "Noted" — drains one observation through the ack route. */
  onAck: (subject: string, observationId: string) => void;
  /** "Noted all" — drains a digest group through the BULK ack route. */
  onAckAll: (subject: string, observationIds: string[]) => void;
  /** Opens the settle dialog for a thread-backed claim. Only a click there
   *  settles anything — this only summons the question. */
  onSettle: (entry: SettleTarget) => void;
  /** Opens the ONE settle-all dialog for the world-answered claims. Only its
   *  confirm sends, through the bulk settle route. */
  onSettleAll: (entries: NeedEntry[]) => void;
  /** §9.1 — the checkbox's close, the shelf's reopen, and Pin…'s PATCH. All
   *  three are the room's handlers so every posture shares one write site. */
  onCloseItem: (id: string) => void;
  onReopenItem: (id: string) => void;
  onPinItem: (id: string, day: string) => void;
  /** §9.2's one quiet inline sentence — the cascade's answer, quoted from the
   *  engine's own counts and refusal reasons, or null for a quiet close. */
  closeNote: string | null;
  /** The bulk verbs' one quiet sentence — refusals and errors aggregated,
   *  the engine's reasons verbatim in quotes, or null when all was quiet. */
  bulkNote: string | null;
  /** Select mode's shared state, or null while the toggle is off. Selection
   *  is VIEW STATE that gathers — the action bar's verbs are where writes
   *  happen, and they never submit turns. */
  selection: { selected: (id: string) => boolean; toggle: (id: string, shiftKey: boolean) => void } | null;
  /**
   * §13: TRUE WHEN THIS `Stance` RENDERS INSIDE A SUBJECT'S ROOM (`room.tsx`'s
   * Tasks tab) RATHER THAN AT THE ROOT. A subject's room already says where
   * you are — the rail and the room's own brief header both name the
   * subject — so the "Focused on X / Show everything" strip and the folded
   * subjects' "meanwhile: …" periphery would repeat that fact a third time,
   * and the periphery specifically duplicates the Lobby's own job of
   * surfacing what moved in OTHER subjects. Suppressed only here: Today and
   * Scheduled still render this component at the root with `scope`
   * undefined, where neither strip has ever applied.
   */
  embedded?: boolean;
  /**
   * §13.8 (2026-08-19), "rows edit in place" — the lanes list and the one
   * generic-PATCH sink every editable row's title/lane/pin/tags gesture
   * calls through (`/api/spool/items/:id`, the SAME route the bulk action
   * bar already speaks). Both optional: callers that omit `onEditItem` get
   * every row's old, read-only rendering — nothing here is a silent
   * behaviour change for an unmigrated caller.
   */
  lanes?: SpoolLane[];
  onEditItem?: (id: string, patch: Record<string, unknown>) => Promise<void>;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const [needsAll, setNeedsAll] = useState(false);

  /** Per-row select props — composed once so every row site spells the same
   *  thing, and nothing renders while the toggle is off. */
  const selectProps = (id?: string) =>
    selection && id
      ? { select: { selected: selection.selected(id), toggle: (shiftKey: boolean) => selection.toggle(id, shiftKey) } }
      : {};
  const shelfSelect = selection ? { select: selection } : {};

  const { needs, housekeeping, onPerson, withAgent, settled, moved, proposal, night, folded, scope, lines, scopeLook, prepared, scopeTotals } = model;
  const [focal, ...rest] = needs;
  const shown = needsAll ? rest : rest.slice(0, NEEDS_VISIBLE);
  const hidden = rest.length - shown.length;

  const needsNothing = needs.length === 0 && housekeeping.length === 0;
  const handsEmpty = !night && work.running.length === 0 && withAgent.length === 0;
  /** FOCUSED-ONLY, 2026-08-19 §13.8: "In its hands" also renders `moved`
   *  lines (below RunningPasses, focused branch only) — `handsEmpty` alone
   *  would call the band non-empty when it is really just movement prose,
   *  and suppressing the wrong thing is worse than not suppressing at all. */
  const handsNothing = handsEmpty && moved.length === 0;

  return (
    /* The main column BREATHES (max-w-3xl in a 1600px viewport), and the
       content stands on a BOUNDED SURFACE — the app's card sheet — so short
       content over empty ground reads as a page with room left, never as a
       dead field. */
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <div className="rounded-xl bg-card px-4 py-6 shadow-1 ring-1 ring-foreground/10">
      {/* ── THE CASCADE'S ONE SENTENCE — §9.2. A close that settled questions
             says so here, once, in the quiet inline idiom: the engine's own
             counts and refusal reasons, quoted, no colour. A close that
             carried nothing stays silent. */}
      {closeNote && (
        <p className="mb-4 px-3 text-xs leading-relaxed text-muted-foreground">{closeNote}</p>
      )}
      {/* The bulk verbs' aggregate — same quiet inline idiom: the engine's
          refusal reasons verbatim, no colour, and silence when all landed
          quietly. */}
      {bulkNote && (
        <p className="mb-4 px-3 text-xs leading-relaxed text-muted-foreground">{bulkNote}</p>
      )}
      {/* ── THE SMART SCOPES' STRIP — the entries live in the toolbar beside
             the posture switch now (one control row, one rhythm); what renders
             HERE is the active scope's own sentence plus the one way back.
             Never shown focused — subject focus is the deeper aperture, and
             stacking the two would be two answers to "where am I". */}
      {!scope && smart && (
        <div className="mb-5 flex min-w-0 items-center gap-3 px-3">
          <span className="min-w-0 truncate text-sm text-foreground">
            {smart === "today" ? (
              <>
                <span className="font-medium">Today</span> — what needs you, and what you pinned to today
              </>
            ) : (
              <>
                <span className="font-medium">Scheduled</span> — everything you pinned, in day order
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => onSmart(null)}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
          >
            Show everything
          </button>
        </div>
      )}

      {/* ── THE APERTURE'S OWN STRIP — visible exactly while it is narrowed,
             and never inside a subject's own room, where the rail and the
             brief header already say where you are (§13). */}
      {scope && !embedded && (
        <div className="mb-5 flex min-w-0 items-center gap-2 px-3">
          <span className="min-w-0 truncate text-sm text-foreground">
            Focused on{" "}
            <button
              type="button"
              onClick={() => onSubject(scope)}
              title={`Everything filed to ${scope}`}
              className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {scope}
            </button>
          </span>
          <button
            type="button"
            onClick={onWiden}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
          >
            Show everything
          </button>
          <button
            type="button"
            onClick={onPermits}
            aria-label={`Permits for ${scope}`}
            title={`What the night may do for ${scope}`}
            className="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
          >
            <ShieldIcon className="size-3.5" />
          </button>
        </div>
      )}

      {!scope ? (
        smart === "today" ? (
          /* ── TODAY — the morning glance, across every subject. The board and
                 calendar postures IGNORE the smart scopes deliberately: the
                 calendar already IS the scheduled view drawn as a grid, and a
                 board narrowed to today's needs would render mostly-empty
                 lanes — an emptiness that reads as "nothing to arrange" when
                 the truth is "you are looking through a keyhole". The scopes
                 slice the STANCE, where the slice is the point. */
          <TodayScope
            model={model}
            onOpenItem={onOpenItem}
            onSuggest={onSuggest}
            onSettle={onSettle}
            onSettleAll={onSettleAll}
            onCloseItem={onCloseItem}
            onPinItem={onPinItem}
            selectProps={selectProps}
          />
        ) : smart === "scheduled" ? (
          <ScheduledScope
            scheduled={model.scheduled}
            onOpenItem={onOpenItem}
            onCloseItem={onCloseItem}
            selectProps={selectProps}
            {...(lanes ? { lanes } : {})}
            {...(onEditItem ? { onEditItem } : {})}
          />
        ) : (
        /* ── WIDE IS FOR CHOOSING — loops §6, committed. One line per subject,
              the focal card, the housekeeping fold, and the morning report:
              enough to decide where to spend yourself, and never every item of
              every subject flattened into bands. The full grammar is what
              focusing buys. Nothing is untouchable from here — the same
              capability set rides the line's own verbs. */
        <>
          <Band mark title="Needs you">
            {needsNothing && lines.length === 0 && <Empty>Nothing needs you.</Empty>}

            {focal && (
              <FocalCard
                entry={focal}
                onOpen={onOpenItem}
                onSuggest={onSuggest}
                {...(focal.threadId ? { onSettle: () => onSettle(focal) } : {})}
                {...(focal.itemId ? { onClose: () => onCloseItem(focal.itemId!) } : {})}
              />
            )}

            {/* AREA HEADERS — loops §8.1. The user's own group names, quiet
                   and visually subordinate to the band headers (smaller, no
                   hairline): work and life share one room without
                   contaminating each other. The area-less tail renders under
                   NO header — see `groupByArea` for why there is no "Other". */}
            {groupByArea(lines).map((group) => (
              <div key={group.area ?? "__no-area"}>
                {group.area && (
                  <p className="px-3 pt-3 pb-1 text-2xs font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                    {group.area}
                  </p>
                )}
                <ul>
                  {group.lines.map((line) => (
                    <SubjectLine
                      key={line.subject}
                      line={line}
                      looking={looking.includes(line.subject)}
                      onScope={onScope}
                      onPermits={onPermits}
                      onSubject={onSubject}
                      onOpen={onOpenItem}
                      onAck={onAck}
                      onAckAll={onAckAll}
                    />
                  ))}
                </ul>
              </div>
            ))}

            <HousekeepingFold
              lines={housekeeping}
              onOpen={onOpenItem}
              onSubject={onSubject}
              onSuggest={onSuggest}
              onClose={onCloseItem}
              onPin={onPinItem}
            />

            {/* THE OFFER, when there is no clear path — proposed, never decided.
                Ignoring it costs nothing, which is what keeps §5's "no
                Telar-authored agenda" true of a band that suggests. */}
            {proposal && (
              <div className="mt-2 px-3">
                <p className="text-xs leading-relaxed text-muted-foreground">{proposal.why}</p>
                <ul className="mt-1">
                  {proposal.options.map((option) => (
                    <Row
                      key={`${option.subject}:${option.threadId ?? option.derived}`}
                      {...(option.said ? { said: option.said } : {})}
                      title={option.derived}
                      meta={option.subject}
                      {...(option.itemId ? { itemId: option.itemId } : {})}
                      onOpen={onOpenItem}
                      {...(option.itemId
                        ? { close: () => onCloseItem(option.itemId!), pin: (day: string) => onPinItem(option.itemId!, day) }
                        : {})}
                    />
                  ))}
                </ul>
              </div>
            )}
          </Band>

          {/* The morning report and the passes in flight stay on arrival —
              §13.2: the report is the top of "In its hands", and a running
              pass is the one thing neither aperture may hide. What choosing
              does NOT show is the per-item inventory of every subject; that
              compresses into each line's counts above. */}
          <Band title="In its hands">
            {handsEmpty && <Empty>Nothing in flight, and no night has run yet.</Empty>}
            {night && <NightCard night={night} onNight={onNight} onOpenItem={onOpenItem} />}
            <RunningPasses work={work} />
          </Band>

          {/* THE DONE SHELF, wide — the choosing view has no Settled band (that
              is focus grammar), so the shelf sits after the bands as its own
              quiet fold. Still a fold, still not a band. */}
          <DoneShelf rows={model.done} onOpen={onOpenItem} onReopen={onReopenItem} {...shelfSelect} />
        </>
        )
      ) : (
        /* ── FOCUS IS THE RESIDENCE — one subject, the full grammar. §13.8
               (2026-08-19), driven live: a quiet room used to lead with FOUR
               near-empty bands ("Nothing needs you." / "Nothing in flight…" /
               "Nothing is parked…" / "Nothing settled yet…") occupying the
               whole first screen above the actual task list — the exact
               "four nearly-empty bands" defect `focus shows the subject's
               actual items` (idiom.test.ts) already named, resurfaced one
               level up. "The subject room IS the task list": each band below
               now renders NOTHING — no header, no quiet sentence — when it
               has nothing to say, so "Waiting its turn" leads the screen by
               default and a band only claims the top when it actually has
               something exceptional to say. */
        <>
          {!needsNothing && (
          <Band mark title="Needs you">
            {focal && (
              <FocalCard
                entry={focal}
                onOpen={onOpenItem}
                onSuggest={onSuggest}
                {...(focal.threadId ? { onSettle: () => onSettle(focal) } : {})}
                {...(focal.itemId ? { onClose: () => onCloseItem(focal.itemId!) } : {})}
              />
            )}

            {/* Above the claims — the world-answered slice, offered as one
                quiet control and settled only through the one dialog. */}
            <SettleAnswered entries={answeredOf(needs)} onSettleAll={onSettleAll} />

            <ul>
              {shown.map((entry) => (
                <Row
                  key={entry.key}
                  {...(entry.said ? { said: entry.said } : {})}
                  title={entry.title}
                  {...(entry.meta ? { meta: entry.meta } : {})}
                  {...(entry.itemId ? { itemId: entry.itemId } : {})}
                  onOpen={onOpenItem}
                  {...(entry.confront ? { confront: entry.confront } : {})}
                  {...(entry.threadId ? { onSettle: () => onSettle(entry) } : {})}
                  {...(entry.itemId
                    ? { close: () => onCloseItem(entry.itemId!), pin: (day: string) => onPinItem(entry.itemId!, day) }
                    : {})}
                  {...selectProps(entry.itemId)}
                />
              ))}
            </ul>

            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setNeedsAll(true)}
                className="mt-1 px-3 py-1 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                and {hidden} more
              </button>
            )}

            <HousekeepingFold
              lines={housekeeping}
              onOpen={onOpenItem}
              onSubject={onSubject}
              onSuggest={onSuggest}
              onClose={onCloseItem}
              onPin={onPinItem}
            />
          </Band>
          )}

          {/* ── SINCE YOUR LAST LOOK — focused only, a strip and never a
                 band, and it sits BELOW "Needs you" now (loops §10's volume
                 work): what needs the hand outranks what happened. Movement
                 is world facts, not claims on you — it never joins Needs you
                 and never grows a fifth tier — so the band that asks for the
                 hand paints first and the news waits under it. The freshness
                 label and the honest error line stay exactly where they
                 were, quoted verbatim from the store; the observations now
                 arrive DIGESTED, one engine line per group, expandable. */}
          {scope && scopeLook?.hasTerrain && (
            <div className="mb-10">
              <div className="flex min-w-0 items-center gap-2 px-3 pb-1">
                <span className="shrink-0 text-2xs font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">Since your last look</span>
                <FreshnessLine look={scopeLook} looking={looking.includes(scope)} />
              </div>
              <MovementDigest
                look={scopeLook}
                subject={scope}
                onOpen={onOpenItem}
                onSubject={onSubject}
                onAck={onAck}
                onAckAll={onAckAll}
              />
            </div>
          )}

          {/* ── IN ITS HANDS ────────────────────────────────────────────── */}
          {!handsNothing && (
          <Band title="In its hands">
            {night && <NightCard night={night} onNight={onNight} onOpenItem={onOpenItem} />}

            <RunningPasses work={work} />

            {/* THE AGENT'S HANDS ONLY. The pickup entry — "you're on X" — is
                the APERTURE, and the focus strip at the top is its one
                renderer; repeating it here dressed your own attention up as
                agent work. What moved on it stays: those are sentences the
                engine composed about the work. */}
            <ul>
              {withAgent.map((t) => (
                <Row
                  key={t.view.thread.id}
                  {...(t.view.items.find((i) => i.said)?.said ? { said: t.view.items.find((i) => i.said)!.said! } : {})}
                  title={t.view.thread.handle?.trim() || t.view.thread.question}
                  meta={clip(`${t.subject} — with the agent${t.view.thread.waiting?.note ? ` · ${t.view.thread.waiting.note}` : ""}`)}
                  {...(t.view.items[0] ? { itemId: t.view.items[0].id } : {})}
                  onOpen={onOpenItem}
                  onSettle={() =>
                    onSettle({
                      subject: t.subject,
                      threadId: t.view.thread.id,
                      title: t.view.thread.handle?.trim() || t.view.thread.question,
                    })
                  }
                />
              ))}
            </ul>
            {moved.length > 0 && (
              <ul className="mt-1 space-y-1 px-3">
                {moved.map((line) => (
                  <li key={line.text} className="text-xs leading-relaxed text-muted-foreground">
                    {line.text}
                  </li>
                ))}
              </ul>
            )}
          </Band>
          )}

          {/* ── WAITING ON OTHERS ───────────────────────────────────────── */}
          {onPerson.length > 0 && (
          <Band title="Waiting on others">
        <ul>
          {onPerson.map((t) => (
            <Row
              key={t.view.thread.id}
              {...(t.view.items.find((i) => i.said)?.said ? { said: t.view.items.find((i) => i.said)!.said! } : {})}
              title={t.view.thread.handle?.trim() || t.view.thread.question}
              meta={clip(
                `${t.view.thread.waiting?.who ?? "someone"}${t.view.thread.waiting?.note ? ` — ${t.view.thread.waiting.note}` : ""} · ${t.subject}`,
              )}
              {...(t.view.items[0] ? { itemId: t.view.items[0].id } : {})}
              onOpen={onOpenItem}
              onSettle={() =>
                onSettle({
                  subject: t.subject,
                  threadId: t.view.thread.id,
                  title: t.view.thread.handle?.trim() || t.view.thread.question,
                })
              }
            />
          ))}
        </ul>
      </Band>
          )}

      {/* ── SETTLED — present, and quiet. §13.8 (2026-08-19): this band is
             "present" only when it has content now — the room stopped
             asserting "and stay" about an empty shelf. */}
      {settled.length > 0 && (
      <Band
        title="Settled"
        aside={<span className="font-mono tabular-nums opacity-60">{settled.length}</span>}
      >
        <button
          type="button"
          aria-expanded={settledOpen}
          onClick={() => setSettledOpen((o) => !o)}
          className="flex items-center gap-1 rounded-md px-3 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", settledOpen && "rotate-90")} />
          {settledOpen ? "Enough" : "What you worked out"}
        </button>
        {settledOpen && (
          <ul>
            {settled.map((t) => (
              <Row
                key={t.view.thread.id}
                {...(t.view.items.find((i) => i.said)?.said ? { said: t.view.items.find((i) => i.said)!.said! } : {})}
                title={t.view.thread.handle?.trim() || t.view.thread.question}
                meta={clip(`${t.subject} — ${t.view.thread.settled?.answer ?? ""}`)}
                {...(t.view.items[0] ? { itemId: t.view.items[0].id } : {})}
                onOpen={onOpenItem}
              />
            ))}
          </ul>
        )}
      </Band>
      )}

          {/* ── WAITING ITS TURN — the residence's inventory, loops §6, and
                 §13.8 (2026-08-19): "the subject room IS the task list" —
                 this is IT, so it leads whenever the exceptional bands above
                 have nothing to say. Prepared items no band claims, grouped
                 by the lane's own stored words. The header stays: it is
                 pinned by `focus shows the subject's actual items` above,
                 which checks for `title="Waiting its turn"` literally — this
                 pass found no cheap way to drop it without weakening that
                 law, so it keeps speaking rather than going silently mute.
                 Rows summon the packet into the tray, like every line in the
                 room. */}
          {prepared.length > 0 && (
            <Band
              title="Waiting its turn"
              aside={
                <span className="font-mono tabular-nums opacity-60">
                  {prepared.reduce((n, group) => n + group.rows.length, 0)}
                </span>
              }
            >
              {prepared.map((group) => (
                <div key={group.key || "__no-lane"}>
                  <p className="px-3 pt-3 pb-1 text-2xs font-medium text-muted-foreground/70">
                    {group.header ?? "not filed in any lane"}
                  </p>
                  <ul>
                    {group.rows.map((row) => (
                      <Row
                        key={row.id}
                        {...(row.said ? { said: row.said } : {})}
                        title={row.title}
                        itemId={row.id}
                        onOpen={onOpenItem}
                        close={() => onCloseItem(row.id)}
                        pin={(day) => onPinItem(row.id, day)}
                        {...selectProps(row.id)}
                        {...(onEditItem
                          ? {
                              onEditTitle: (next: string) => onEditItem(row.id, { title: next }),
                              disclose: {
                                ...(group.key ? { lane: group.key } : {}),
                                lanes: lanes ?? [],
                                tags: row.tags,
                                ...(row.pinnedDay ? { pinnedDay: row.pinnedDay } : {}),
                                onLane: (lane: string) => void onEditItem(row.id, { lane }),
                                onPin: (day: string | null) => void onEditItem(row.id, { pinned: day ? { day } : null }),
                                onTags: (tags: string[]) => void onEditItem(row.id, { tags }),
                              },
                            }
                          : {})}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </Band>
          )}

          {/* ── DONE — §9.3's shelf, moved to the FOOT of the list
                 (2026-08-19, §13.8: "a 'show completed' foot on each list"),
                 below "Waiting its turn" rather than above the Settled
                 region — closed items are the room's own foot fold, not a
                 second thing to read before reaching the tasks. Collapsed by
                 default, unchanged. */}
          <DoneShelf rows={model.done} onOpen={onOpenItem} onReopen={onReopenItem} {...shelfSelect} />
        </>
      )}

      {/* WHAT THE APERTURE IS NOT SHOWING — one quiet line, checked in code.
          Never inside a subject's room (§13): its "meanwhile: …" periphery
          duplicates the Lobby's own job of surfacing other subjects'
          movement, and `folded` is empty anyway whenever `scope` is unset
          (Today/Scheduled), so this only ever had content to suppress here. */}
      {!embedded && <FoldedLine folded={folded} onWiden={onWiden} />}

      {/* ── THE STORE'S HONESTY LINES, inherited from the retired queue: the
             conservation law with live numbers, and the diagnostic channel —
             a skipped row no surface admits to would make tolerance
             indistinguishable from loss. UNDER SCOPE (2026-08-19, §13.8) the
             conservation pair reads `scopeTotals` — this subject's own count
             — instead of the store's, and the diagnostic channel (a WHOLE-
             STORE read with no subject of its own) stays quiet rather than
             attributing another subject's unreadable row to this room. */}
      {totals && (
        <div className="mt-8 space-y-1 border-t border-border/40 px-3 pt-3">
          {!scope && totals.unreadable.length > 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {totals.unreadable.length} {totals.unreadable.length === 1 ? "row" : "rows"} could not be read — skipped
              and reported, never dropped silently.
            </p>
          )}
          {scope && scopeTotals ? (
            <p className="text-xs leading-relaxed text-muted-foreground/60">
              {scopeTotals.totalItems} {scopeTotals.totalItems === 1 ? "item" : "items"} in {scope} · agents added{" "}
              {scopeTotals.agentsAdded}
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground/60">
              {totals.totalItems} items · agents added {totals.agentsAdded} · the count never grows from breakdown.
            </p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * THE FLOATING ACTION BAR — the selection model's verbs, loops §10's "the
 * hand's verbs finally compound". Renders only while something is selected,
 * at the foot of the main column in the app's card idiom, and every verb is
 * a STORE WRITE through the human routes — close through the BULK route,
 * lane/pin/tag as one PATCH per item — with NO turn submitted anywhere:
 * gathering and acting are the hand's, and the chat only notices the way it
 * notices everything, in the next snapshot. Tag… is ADDITIVE — it states one
 * more word, it never rewrites the words already there. Clear selection
 * undoes nothing, because selecting wrote nothing.
 */
export function SelectionBar({
  count,
  lanes,
  busy,
  onCloseMany,
  onLane,
  onPin,
  onTag,
  onClear,
}: {
  count: number;
  lanes: SpoolLane[];
  busy: boolean;
  onCloseMany: () => void;
  onLane: (lane: string) => void;
  onPin: (day: string) => void;
  onTag: (tag: string) => void;
  onClear: () => void;
}) {
  const [tag, setTag] = useState("");
  if (count === 0) return null;
  const commitTag = () => {
    const word = tag.trim();
    if (!word) return;
    setTag("");
    onTag(word);
  };
  return (
    <div className="pointer-events-none sticky bottom-4 z-10 mx-auto w-full max-w-3xl px-6">
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl bg-card px-3 py-2 shadow-2 ring-1 ring-foreground/10">
        <span className="shrink-0 text-xs font-medium text-foreground">
          {count} selected
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onCloseMany}
          title="Tick them all — one request through the bulk close route; each close cascades like a single tick"
          className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
        >
          Close
        </button>
        {/* Move to lane… — the packet face's own select, applied per item. */}
        <select
          aria-label="Move the selection to a lane"
          title="Move to a lane — one re-file per item, through the same PATCH the packet face speaks"
          disabled={busy}
          value=""
          onChange={(event) => {
            const lane = event.currentTarget.value;
            if (lane) onLane(lane);
          }}
          className="h-6 shrink-0 rounded-md border border-border bg-transparent px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Move to lane…</option>
          {lanes.map((lane) => (
            <option key={lane.key} value={lane.key}>
              {lane.label}
            </option>
          ))}
        </select>
        {/* Pin to day… — picking the day IS stating it, per item. */}
        <input
          type="date"
          aria-label="Pin the selection to a day"
          title="Pin to a day — your own date, stated once for every selected item"
          disabled={busy}
          onChange={(event) => {
            const day = event.currentTarget.value;
            if (day) onPin(day);
          }}
          className="h-6 w-[7.5rem] shrink-0 rounded-md border border-border bg-transparent px-1.5 text-3xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        {/* Tag… — additive: one more word on each, never a rewrite. */}
        <Input
          value={tag}
          disabled={busy}
          onChange={(event) => setTag(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitTag();
            }
          }}
          placeholder="Tag…"
          aria-label="Tag the selection"
          title="Add one tag to every selected item — additive, nothing is removed"
          className="h-6 w-24 text-xs md:text-xs"
        />
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}

/**
 * THE ROOM — rail, main, and the summoned layer. §13.6, "the assistant's two
 * doors", retired the old three-column shape (a resident chat riding beside a
 * separately-summoned tray — the "4-column bug" once the rail is counted):
 * there is now ONE overlay, holding ONE slot, conversation XOR a face, and a
 * second door — the Assistant room — that holds the same conversation
 * full-width. This component owns every read the columns share, for the
 * reason the master chat recorded when it owned them: a hook per surface is
 * three polls of one endpoint disagreeing by up to a tick.
 */
export function SpoolStance({ initialItem }: { initialItem?: string }) {
  const work = useSpoolWork();
  const [map, setMap] = useState<SpoolMap | null>(null);
  const [focus, setFocus] = useState<{ pickup: SpoolPickup; days: SpoolFocusDay[] } | null>(null);
  const [night, setNight] = useState<SpoolNight | null>(null);
  const [desk, setDesk] = useState<SpoolDeskCard[]>([]);
  /** The inventory axes of the same snapshot read: the subject groups and the
   *  lane records, so the focused residence can show the subject's actual
   *  filed items under the lanes' own stored words. */
  const [inventory, setInventory] = useState<SpoolSubjectGroup[]>([]);
  const [lanes, setLanes] = useState<SpoolLane[]>([]);
  /** The subject RECORDS — identity (area, color), terrain, permits — read
   *  once with the snapshot and JOINED BY KEY into the derivation, so lines,
   *  board, calendar and tray all see the same identity without a fetch of
   *  their own. */
  const [subjectRecords, setSubjectRecords] = useState<SpoolSubject[]>([]);
  const [totals, setTotals] = useState<{ totalItems: number; agentsAdded: number; unreadable: SpoolUnreadable[] } | null>(null);
  /** THE APERTURE SLOT IS GONE FROM THIS SURFACE — §13.6 + the tool removal
   *  that came with it. The room used to follow the chat's `spool_set_aperture`
   *  write (loops §8.1's shared slot); that tool no longer exists on the
   *  wall, and since §13.6 the assistant has no screen-moving hand at all —
   *  the room belongs to the user's, moved only by a click, and the agent
   *  answers in words. Nothing here reads the slot or navigates from it any
   *  more; see the removed `lastAppliedAperture` follow this comment
   *  replaces, and the smart-scope note below for what still lives (Today
   *  and Scheduled as plain room state, written only by the hand's clicks). */
  /** The STORED looks — cheap, no network on the engine side, part of the
   *  arrival snapshot so the room paints instantly and honestly stale. */
  const [looks, setLooks] = useState<SpoolLookOutcome[]>([]);
  /** Subjects whose reconcile is in flight. Freshness ARRIVES; it never
   *  blocks paint. The ref is the synchronous truth `reconcile` guards on;
   *  the state is the same fact for the renderer's pulse. */
  const lookInFlight = useRef<Set<string>>(new Set());
  const [looking, setLooking] = useState<string[]>([]);
  /** Whether the arrival reconcile has been fired — once per mount, and only
   *  after the stored snapshot said which subjects have terrain. */
  const [lookedOnArrival, setLookedOnArrival] = useState(false);
  /**
   * THE SUMMONED LAYER'S ONE SLOT — §13.6. Conversation XOR a face, never
   * both: the old shape held a resident `MasterChat` aside AND a separately
   * summoned `tray`, which is how a subject's packet and the chat both got a
   * column at once. `layer` replaces both — `null` is two columns (rail,
   * main), `{ kind: "chat" }` and `{ kind: "face", face }` are the layer's
   * only two shapes. Seeded by the deep link — `/spool/[id]` redirects here
   * with `?item=` — so an old packet URL lands in the room with the layer
   * already open on its face.
   */
  type SpoolLayer = { kind: "chat" } | { kind: "face"; face: TrayFace };
  const [layer, setLayer] = useState<SpoolLayer | null>(
    initialItem ? { kind: "face", face: { kind: "packet", id: initialItem } } : null,
  );
  const openFace = useCallback((face: TrayFace) => setLayer({ kind: "face", face }), []);
  /** A line's chat verb, on its way to the composer. The counter is what lets
   *  the same suggestion be pressed twice. Summons the layer's chat slot —
   *  §13.6: the suggestion IS an invitation into the conversation. */
  const [suggestion, setSuggestion] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const suggest = useCallback((text: string) => {
    setSuggestion((prev) => ({ text, n: prev.n + 1 }));
    setLayer({ kind: "chat" });
  }, []);

  const openItem = useCallback((id: string) => openFace({ kind: "packet", id }), [openFace]);

  /**
   * ONE READ FOR THE WHOLE ROOM. The bands are one projection of four
   * records, and fetching them on separate cadences would let one band show a
   * pass's result while its neighbour still shows the pass — the disagreement
   * the one-call snapshot rule exists to prevent, applied across calls by
   * refreshing them together.
   */
  const load = useCallback(async () => {
    try {
      const [mapRes, focusRes, nightRes, spoolRes, looksRes, subjectsRes] = await Promise.all([
        fetch("/api/spool/threads"),
        fetch("/api/spool/focus"),
        fetch("/api/spool/night"),
        fetch("/api/spool"),
        // The stored looks ride the same snapshot: no network on the engine
        // side, so arrival stays instant — freshness comes later, by pull.
        fetch("/api/spool/looks"),
        // The subject records ride it too — the identity join's one read.
        fetch("/api/spool/subjects"),
      ]);
      if (mapRes.ok) setMap((await mapRes.json()) as SpoolMap);
      if (looksRes.ok) setLooks(((await looksRes.json()).looks ?? []) as SpoolLookOutcome[]);
      if (subjectsRes.ok) setSubjectRecords(((await subjectsRes.json()).subjects ?? []) as SpoolSubject[]);
      if (focusRes.ok) setFocus((await focusRes.json()) as { pickup: SpoolPickup; days: SpoolFocusDay[] });
      if (nightRes.ok) setNight(((await nightRes.json()).night ?? null) as SpoolNight | null);
      if (spoolRes.ok) {
        const snapshot = await spoolRes.json();
        setDesk((snapshot.desk ?? []) as SpoolDeskCard[]);
        setInventory((snapshot.subjects ?? []) as SpoolSubjectGroup[]);
        setLanes((snapshot.lanes ?? []) as SpoolLane[]);
        setTotals({
          totalItems: snapshot.totalItems ?? 0,
          agentsAdded: snapshot.agentsAdded ?? 0,
          unreadable: (snapshot.unreadable ?? []) as SpoolUnreadable[],
        });
      }
    } catch {
      // A dropped read leaves the last good stance up. It is pull-based, and a
      // failed request has not unmade anything.
    }
  }, []);

  useEffect(() => {
    // Deferred to a task rather than run in the effect body — a synchronous
    // fetch-and-setState on mount is a cascading render, and this app lints it.
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  /**
   * SETTLING A CONFRONTED CLAIM — the one settle path on this surface, and it
   * is a human's two clicks: the row's verb only fills this state, and only
   * the dialog's confirm sends anything. THE ANSWER IS RECORDED, NOT INVENTED:
   * the prefill composes from the observation's stored text and seen label —
   * the world's own sentence about what happened — and stays editable, because
   * the human may know more than the look did. An empty answer is refused by
   * the route, the daemon and the store alike; nothing here softens that.
   */
  const [settling, setSettling] = useState<{ subject: string; threadId: string; title: string } | null>(null);
  const [settleAnswer, setSettleAnswer] = useState("");
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const askSettle = useCallback((entry: SettleTarget) => {
    if (!entry.threadId) return;
    // The prefill IS the observation when the world spoke — stored words,
    // stored seen label — and EMPTY otherwise: §9.4 made Settle a standing
    // hand verb on every thread-backed claim, not a confrontation-only one,
    // and an unconfronted settle has no stored sentence to offer, so nothing
    // is invented. The dialog's required answer stays the human's either way.
    setSettleAnswer(entry.confront ? `${entry.confront.text} (seen ${entry.confront.seen})` : "");
    setSettleError(null);
    setSettling({ subject: entry.subject, threadId: entry.threadId, title: entry.said ?? entry.title });
  }, []);
  const confirmSettle = () => {
    if (!settling || settleBusy) return;
    setSettleBusy(true);
    setSettleError(null);
    void fetch(`/api/spool/threads/${encodeURIComponent(settling.subject)}/${encodeURIComponent(settling.threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settle: { answer: settleAnswer } }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        setSettling(null);
        await load();
      })
      .catch((err) => setSettleError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSettleBusy(false));
  };

  /**
   * A PASS THAT LANDED CHANGED WHAT THE SPOOL HOLDS — so re-read. Keyed on how
   * many are RUNNING rather than on the record: that number falls exactly once
   * per settle, where watching the array would re-read on every step.
   */
  const runningCount = work.running.length;
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [runningCount, load]);

  /**
   * §13: THE LOBBY IS THE LANDING. Every arrival at `/spool` starts here,
   * full stop — no seed from the focus log's "newest open entry", the way
   * an earlier pass (loops §8.1, "a glance is not work") once opened
   * straight into whichever subject you were last on. That behavior
   * quietly defeated the lobby's whole job: ranking across subjects so you
   * decide where to go, rather than the room deciding for you by replaying
   * your last click. The focus log still records `goSubject`'s POSTs (the
   * chat's pickup still needs "you're on X"), and still seeds the SETTLE
   * dialogs' subject-scoped state elsewhere in this file — it simply no
   * longer seeds the ROOM. `room` is plain state now, `{ kind: "lobby" }`
   * on mount and moved only by a click (`goSubject`/`goToday`/
   * `goScheduled`/`goLobby`) — §13.6 retired the one other mover, the
   * aperture slot's one-way wire, along with the tool that wrote it.
   */
  const [room, setRoom] = useState<SpoolRoomState>({ kind: "lobby" });
  const scope = room.kind === "subject" ? room.key : undefined;

  /**
   * RECONCILE, PULLED — loops §4. The one trigger is a reason to look: the
   * user arrived, or a subject was focused. Never a timer, never a
   * subscription. Fire-and-forget per subject: the stored stance stays up,
   * the pulse marks the subject, and the fresh outcome replaces its look when
   * it lands — including the honest `fresh:false + error` one, which is an
   * answer to render, not a fault to swallow.
   */
  const reconcile = useCallback((subject: string) => {
    // ONE PULL PER SUBJECT AT A TIME. Arrival and focus-entry can both name
    // the scoped subject in the same tick; state has not committed yet at
    // that point, so the guard is a ref — synchronous, and never rendered.
    if (lookInFlight.current.has(subject)) return;
    lookInFlight.current.add(subject);
    setLooking((prev) => (prev.includes(subject) ? prev : [...prev, subject]));
    void fetch("/api/spool/look", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const fresh = (await res.json()).look as SpoolLookOutcome | undefined;
        if (fresh) setLooks((prev) => [...prev.filter((l) => l.subject !== fresh.subject), fresh]);
      })
      .catch(() => undefined)
      .finally(() => {
        lookInFlight.current.delete(subject);
        setLooking((prev) => prev.filter((s) => s !== subject));
      });
  }, []);

  /**
   * RECONCILE-ON-ARRIVAL: once, after the stored snapshot has painted and
   * said which subjects have terrain. Deferred to a task like every other
   * mount read, and gated by state rather than a ref so the development
   * double-invoke cannot skip it the way the master chat's old ref guard did.
   */
  useEffect(() => {
    if (lookedOnArrival || looks.length === 0) return;
    const task = window.setTimeout(() => {
      setLookedOnArrival(true);
      for (const outcome of looks) if (outcome.terrain) reconcile(outcome.subject);
    }, 0);
    return () => window.clearTimeout(task);
  }, [lookedOnArrival, looks, reconcile]);

  /** "Noted" — drains through the ack route. The engine marks and keeps the
   *  row; the fresh look replaces the stored one, so the count falls without
   *  anything being deleted. */
  const acknowledge = useCallback((subject: string, observationId: string) => {
    void fetch(`/api/spool/looks/${encodeURIComponent(subject)}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observationId }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const drained = (await res.json()).look as SpoolLookOutcome["look"] | undefined;
        if (drained) {
          setLooks((prev) => prev.map((l) => (l.subject === drained.subject ? { ...l, look: drained } : l)));
        }
      })
      .catch(() => undefined);
  }, []);

  /** "Noted all" — a digest group drains through the BULK ack route, one
   *  POST for the group's ids, never a loop over the single route. The
   *  engine marks and keeps every row; the returned look replaces the stored
   *  one exactly as the single ack's does. */
  const acknowledgeAll = useCallback((subject: string, observationIds: string[]) => {
    void fetch(`/api/spool/looks/${encodeURIComponent(subject)}/ack-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observationIds }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const drained = (await res.json()).look as SpoolLookOutcome["look"] | undefined;
        if (drained) {
          setLooks((prev) => prev.map((l) => (l.subject === drained.subject ? { ...l, look: drained } : l)));
        }
      })
      .catch(() => undefined);
  }, []);

  /**
   * SETTLE-ALL-ANSWERED — the volume pass's one compound settle, and still a
   * human's two clicks: the quiet control only fills this state, and ONLY the
   * one dialog's confirm sends — through the BULK settle route, one POST per
   * subject the selection spans, never a loop over the single thread route.
   * THE ANSWERS ARE RECORDED, NOT INVENTED: each prefill is the existing
   * composition — the confrontation observation's stored text and seen label
   * — shown in the dialog before anything is written. Per-row refusals come
   * back beside what landed and render verbatim after, in the quiet inline
   * idiom. Nothing here is automatic.
   */
  const [settlingMany, setSettlingMany] = useState<Array<{
    subject: string;
    threadId: string;
    title: string;
    answer: string;
  }> | null>(null);
  const [settleManyBusy, setSettleManyBusy] = useState(false);
  const [settleManyError, setSettleManyError] = useState<string | null>(null);
  /** The bulk verbs' one quiet sentence — refusals verbatim, or null. */
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  // NOT `useCallback`, deliberately — the same reasoning `widen` records:
  // React Compiler cannot preserve a manual memo around this body (the
  // type-guard filter defeats it) and the lint says so. A plain function has
  // no memo to preserve, and this one runs on a click, where its cost is
  // nothing.
  const askSettleAll = (entries: NeedEntry[]) => {
    const rows = entries
      .filter((e): e is NeedEntry & { threadId: string; confront: NonNullable<NeedEntry["confront"]> } =>
        !!e.threadId && !!e.confront,
      )
      .map((e) => ({
        subject: e.subject,
        threadId: e.threadId,
        title: e.said ?? e.title,
        // The existing composition — the observation's stored words and seen
        // label, exactly what the single settle prefills.
        answer: `${e.confront.text} (seen ${e.confront.seen})`,
      }));
    if (rows.length === 0) return;
    setSettleManyError(null);
    setSettlingMany(rows);
  };
  const confirmSettleMany = () => {
    if (!settlingMany || settleManyBusy) return;
    setSettleManyBusy(true);
    setSettleManyError(null);
    void (async () => {
      try {
        // One bulk POST per subject the answered claims span — the route is
        // per-subject; the loop is over subjects, never over threads.
        const bySubject = new Map<string, Array<{ threadId: string; answer: string }>>();
        for (const row of settlingMany) {
          bySubject.set(row.subject, [...(bySubject.get(row.subject) ?? []), { threadId: row.threadId, answer: row.answer }]);
        }
        const refusals: string[] = [];
        let landed = 0;
        for (const [subject, settles] of bySubject) {
          const res = await fetch(`/api/spool/threads/${encodeURIComponent(subject)}/settle-many`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settles }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
          landed += (data.settled ?? []).length;
          refusals.push(...((data.refused ?? []) as Array<{ reason: string }>).map((r) => `“${r.reason}”`));
        }
        setSettlingMany(null);
        setBulkNote(
          [
            landed === 1 ? "settled 1 thread" : `settled ${landed} threads`,
            ...refusals,
          ].join("; "),
        );
        await load();
      } catch (err) {
        setSettleManyError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettleManyBusy(false);
      }
    })();
  };

  /**
   * THE HAND CLOSES — §9. One write site per verb for every posture: the
   * stance's rows, the board's cards, the calendar's lines and the shelves
   * all call these. The shared helper POSTs the DEDICATED close/reopen
   * routes (never the generic PATCH — `closed` is refused there by name) and
   * hands back the cascade's one sentence, quoted from the engine's own
   * counts and refusal reasons. No dialog anywhere on this path: tick, it's
   * done; untick, it's back. The snapshot reload is what moves the row to or
   * from the Done shelf.
   */
  const [closeNote, setCloseNote] = useState<string | null>(null);
  const closeByHand = useCallback(
    (id: string) => {
      void closeItemByHand(id)
        .then((sentence) => {
          setCloseNote(sentence);
          return load();
        })
        .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
    },
    [load],
  );
  const reopenByHand = useCallback(
    (id: string) => {
      void reopenItemByHand(id)
        .then(() => {
          // A reopen is quiet — and it retires the last close's sentence,
          // which no longer describes the desk.
          setCloseNote(null);
          return load();
        })
        .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
    },
    [load],
  );

  /** Pin…, the row verb — §9.4. The same `{pinned: {day}}` PATCH the packet
   *  face and the calendar already speak; picking the day IS stating it, and
   *  a refusal is the engine's sentence in the same quiet inline slot. */
  const pinByHand = useCallback(
    (id: string, day: string) => {
      void fetch(`/api/spool/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: { day } }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
          await load();
        })
        .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
    },
    [load],
  );

  /** §13.8 (2026-08-19)'s shared row grammar's one write sink for Today and
   *  Scheduled — the SAME generic item PATCH `room.tsx`'s own `onEditItem`
   *  speaks, kept a Promise here (rather than folding into `closeNote`) so
   *  the row itself can revert its optimistic edit on a rejection. */
  const editByHand = useCallback(
    (id: string, patch: Record<string, unknown>) =>
      fetch(`/api/spool/items/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        await load();
      }),
    [load],
  );

  /**
   * ENTERING FOCUS IS A REASON TO LOOK — the second of the two pulls. Keyed
   * on the SCOPE rather than on the button, because the chat can focus the
   * room too (`spool_set_focus`) and both arrivals deserve the same glance.
   * `lastScopeLooked` keeps it one look per entry, not one per render.
   */
  const [lastScopeLooked, setLastScopeLooked] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!scope || scope === lastScopeLooked) return;
    const task = window.setTimeout(() => {
      setLastScopeLooked(scope);
      if (looks.some((l) => l.subject === scope && l.terrain)) reconcile(scope);
    }, 0);
    return () => window.clearTimeout(task);
  }, [scope, lastScopeLooked, looks, reconcile]);

  /**
   * THE SMART SCOPES — Today and Scheduled are plain `room` state now, moved
   * only by a click, like every other room. Loops §8.1 had these read from
   * an engine-side APERTURE SLOT the chat's `spool_set_aperture` tool could
   * also write ("muéstrame lo de hoy" moving the room out from under the
   * hand); §13.6 retired the assistant's screen-moving hand entirely — the
   * tool is gone from the wall — and with it the slot this UI ever needed to
   * read. There is nothing left to follow: no fetch, no ref telling an
   * external write apart from this component's own, no effect racing a
   * click. The room is the user's alone; the agent answers in words.
   *
   * PRECEDENCE STILL HOLDS: SUBJECT FOCUS IS THE DEEPER APERTURE, and it was
   * never the slot's to clear — the render simply branches on `scope` first,
   * so entering a subject's room covers Today/Scheduled without erasing
   * which of them was open, and leaving reveals it again.
   *
   * Today and Scheduled are still deliberately never written to the engine's focus store —
   * a computed glance is not the kind of fact the focus log records (that
   * is `goSubject`'s alone, below), so this stays view state.
   */

  /** THE FLOOR PLAN'S OWN VERBS — §13.2. Every one lands on a room; none of
   *  them touch any engine-side slot — that machinery is gone (see above).
   *  `goSubject` still POSTs the focus log — the chat's pickup still
   *  needs "you're on X" recorded — but the room itself moves NOW, the same
   *  immediacy `focusOn` used to give, because re-opening an already-current
   *  focus entry is a no-op on the log and would otherwise leave the room
   *  standing still. */
  const goLobby = useCallback(() => setRoom({ kind: "lobby" }), []);
  const goToday = useCallback(() => setRoom({ kind: "today" }), []);
  const goScheduled = useCallback(() => setRoom({ kind: "scheduled" }), []);
  /** §13.6's second door — the same conversation, full-width, reached
   *  directly from the rail or by expanding out of the summoned layer. */
  const goAssistant = useCallback(() => setRoom({ kind: "assistant" }), []);
  /** WALK INTO A CONTAINER — §13.8, 2026-08-19. The Lobby's own container
   *  rows (and an area page's own children) call this on a name click; the
   *  chevron beside it still only toggles collapse in place. */
  const goArea = useCallback((path: string) => setRoom({ kind: "area", path }), []);
  const goSubject = useCallback(
    (subject: string) => {
      setRoom({ kind: "subject", key: subject });
      void fetch("/api/spool/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      })
        .then(() => load())
        .catch(() => undefined);
    },
    [load],
  );

  /** Which day is today — the ONE sanctioned clock read (`lib/spool-today`,
   *  §3.2 as amended), taken here so every room and the derivation agree on
   *  it within a render. */
  const today = todayDay();

  /** THE WIDE MODEL — `scope` undefined, for Today and Scheduled, the two
   *  cross-subject rooms §13.2 keeps. THE SCOPED MODEL — this room's own
   *  subject, for the subject room's brief and its Tasks tab. Both are the
   *  same derivation, called twice: cheap and pure, never a second store. */
  const wideModel = deriveStance(map, focus, night, desk, undefined, looks, inventory, lanes, today, subjectRecords);
  const model = room.kind === "subject" ? deriveStance(map, focus, night, desk, scope, looks, inventory, lanes, today, subjectRecords) : wideModel;
  const openers = deriveOpeners(wideModel);

  /** A search hit does what its kind means: a packet or a note opens the
   *  layer's face slot beside whatever room is open; a subject hit GOES TO
   *  that subject's room — the overlay itself never navigates further than
   *  that. */
  const openHit = (hit: SpoolSearchHit) => {
    if (hit.kind === "item") openFace({ kind: "packet", id: hit.id });
    else if (hit.kind === "note") openFace({ kind: "note", id: hit.id });
    else if (hit.subject) goSubject(hit.subject);
    else openFace({ kind: "subject", key: null });
  };

  /**
   * THE VIEW-CONTEXT LINE every turn carries — see `MasterChat.context`. One
   * bracketed line, composed from the same derivation the bands render, so
   * "file this" and "what's this about" resolve against what is actually on
   * screen. Counts, a scope and a tray address; no prose, no clock.
   */
  // The pickup entry is not counted: your focus is the aperture (`scope=`
  // already names it), not something in the agent's hands.
  const handsCount = (model.night ? 1 : 0) + work.running.length + model.withAgent.length;
  /** FRESHNESS RIDES THE SAME LINE — the labels quoted, compacted, never
   *  computed: `looks=ozom-gv@Sat-13:24+2moved`. The chat knows exactly what
   *  the room knows about the world, and nothing more. */
  const lookNotes = model.lines
    .filter((l) => l.look.hasTerrain && l.look.lastLooked)
    .map(
      (l) =>
        `${l.subject}@${(l.look.lastLooked ?? "").replace(/^looked\s+/, "").replace(/\s+/g, "-")}${
          l.look.moved.length > 0 ? `+${l.look.moved.length}moved` : ""
        }`,
    );
  // `room=` names the floor-plan room the chat is beside — a subject room
  // reports its own key, the two day rooms report their own kind, and the
  // lobby is the quiet default. No aperture, no posture, no filter: §13
  // retired all three as facts the chat needed to know.
  const roomLabel = room.kind === "subject" ? room.key : room.kind === "area" ? `area:${room.path}` : room.kind;
  const viewContext = `[room: room=${roomLabel} · layer=${
    layer ? (layer.kind === "chat" ? "chat" : layer.face.kind === "packet" ? `packet:${layer.face.id}` : layer.face.kind) : "closed"
  } · needs-you=${model.needs.length + model.housekeeping.length} in-its-hands=${handsCount} waiting-on-others=${model.onPerson.length} settled=${model.settled.length}${
    lookNotes.length > 0 ? ` · looks=${lookNotes.join(",")}` : ""
  }]`;

  /**
   * PUBLISHED FOR THE RAIL — §13.2. The rail is floor-plan-only now: which
   * room is open, and the Areas → subjects tree with its one honest count
   * per subject, drawn from `wideModel.lines` so the tree never narrows to
   * whatever subject happens to be open. The rail's clicks drive the SAME
   * `room` state this component owns, through the verbs below — never a
   * second copy of it. `lib/spool-room.ts` explains why this is a plain
   * publish rather than a context: the nav is a SIBLING in the tree (the app
   * sidebar sits beside this page, never inside it), so nothing here could
   * hand it a Provider even if it wanted to.
   */
  useEffect(() => {
    publishSpoolRoom(
      {
        ready: true,
        room,
        areas: wideModel.lines.map((line) => ({
          subject: line.subject,
          needs: line.needs,
          ...(line.area ? { area: line.area } : {}),
          ...(line.color ? { color: line.color } : {}),
          ...(line.rank !== undefined ? { rank: line.rank } : {}),
        })),
      },
      { goLobby, goToday, goScheduled, goSubject, goAssistant, goArea, openSearchHit: openHit, refresh: load },
    );
  }, [room, wideModel.lines, goLobby, goToday, goScheduled, goSubject, goAssistant, goArea, load]);
  // The room's own unmount is the one honest moment to blank the slot: a
  // stale aperture or filter from a PREVIOUS visit must never haunt the
  // sidebar for whatever renders next (Telar's own place has no rail to
  // read it, but the same `/spool` visited again should not open on
  // yesterday's squint either).
  useEffect(() => clearSpoolRoom, []);

  /**
   * ⌘J MEANS "GIVE ME THE ASSISTANT" — not a bare toggle of the layer's
   * presence. THREE STATES, not two: closed → chat (open it), face → chat
   * (a face up is not the assistant answering — swap to the slot that is),
   * chat → closed (the assistant is already what you have; dismiss it). A
   * face is never reached from here — the header's own back-to-chat button
   * and the tray's face-summoning verbs are the only doors into it.
   */
  const toggleAssistant = useCallback(() => {
    setLayer((current) => (current && current.kind === "chat" ? null : { kind: "chat" }));
  }, []);

  /**
   * ⌘J DRIVES THE SAME VERB — §13.6's own keybinding, the same
   * `window.addEventListener("keydown", …)` idiom every other Spool shortcut
   * uses (see `lib/use-command-keys.ts`). Escape closes it when it is open;
   * neither key is claimed when the layer is already closed, so Escape never
   * swallows some OTHER surface's own handling (a dialog's, say) for a key
   * this room has nothing open to close.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleAssistant();
        return;
      }
      if (event.key === "Escape" && layer) setLayer(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layer, toggleAssistant]);

  return (
    /* THE ROOM'S GROUND IS THE CANVAS. The old `bg-muted/25` wash was one
       value step, invisible in dark mode — three columns reading as one void.
       The layering now comes from real surfaces: the side columns step to the
       rail token (`bg-sidebar`, a legible step in BOTH schemes) behind their
       hairlines, and the stance's content stands on its own card sheet. Hue
       still stays on icons; the room still says so with a mark.

       `app-ground` because that canvas is a GROUND: this is the room's own
       full-height sheet, and a backdrop has to show through it exactly as it
       shows through the cockpit's. */
    <div className="app-ground relative flex h-dvh flex-col bg-background">
      <SpoolHeader description="Where you left off, what moved, and what needs you." />
      {/* THE LAYER'S SUMMONING DOOR — §13.6. Rendered outside `SpoolHeader`'s
          own props on purpose: that component has no `actions` slot by
          design (see its own doc comment), so this button overlaps the
          header row from the relatively-positioned wrapper above instead.
          `app-no-drag` is required here — this row sits inside the titlebar's
          drag region, and without the class a click would drag the window
          rather than land on the button. */}
      <button
        type="button"
        aria-pressed={layer?.kind === "chat"}
        aria-label={!layer ? "Open the assistant" : layer.kind === "face" ? "Switch to the assistant" : "Close the assistant"}
        title="Assistant (⌘J)"
        onClick={toggleAssistant}
        className="app-no-drag absolute right-4 top-3 z-10 flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <MessageCircleIcon className="size-4" aria-hidden />
      </button>
      <div className="relative flex min-h-0 flex-1">
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            room.kind === "assistant" ? "flex flex-col overflow-hidden" : "overflow-y-auto",
          )}
        >
          {/* THE FLOOR PLAN'S FIVE ROOMS — §13.2, extended by §13.6. Navigation
              IS state (the room never has its own route; `/spool` is the only
              URL), so this switch is the whole front door: Lobby ranks and
              folds (no toolbar of its own to speak of), Today and Scheduled
              reuse `Stance`'s own smart-scope rendering wholesale rather than a
              second copy of `TodayScope`/`ScheduledScope` wrapped a second
              way, a subject's room opens on its brief before its tabs, and the
              Assistant room is the same `MasterChat` full-width, the second of
              the assistant's two doors. The header stays untouched (navigation
              must not move), and the summoned layer holds its place through
              every switch. */}
          {room.kind === "lobby" && (
            <Lobby
              onEnterSubject={goSubject}
              onChanged={load}
              onEnterArea={goArea}
              onEnterToday={goToday}
              onEnterScheduled={goScheduled}
              todayCount={wideModel.needs.length}
              scheduledCount={wideModel.scheduled.slipped.length + wideModel.scheduled.days.reduce((sum, day) => sum + day.rows.length, 0)}
            />
          )}
          {(room.kind === "today" || room.kind === "scheduled") && (
            <Stance
              model={wideModel}
              work={work}
              totals={totals}
              looking={looking}
              smart={room.kind}
              onSmart={(next) => (next ? undefined : goLobby())}
              onOpenItem={openItem}
              onNight={() => openFace({ kind: "night" })}
              onPermits={() => openFace({ kind: "permits" })}
              onSubject={(key) => (key ? goSubject(key) : openFace({ kind: "subject", key: null }))}
              onScope={goSubject}
              onWiden={goLobby}
              onSuggest={suggest}
              onAck={acknowledge}
              onAckAll={acknowledgeAll}
              onSettle={askSettle}
              onSettleAll={askSettleAll}
              onCloseItem={closeByHand}
              onReopenItem={reopenByHand}
              onPinItem={pinByHand}
              closeNote={closeNote}
              bulkNote={null}
              selection={null}
              lanes={lanes}
              onEditItem={editByHand}
            />
          )}
          {room.kind === "subject" && (
            // KEYED BY THE SUBJECT, so walking to another one REMOUNTS the
            // room rather than resetting it field by field. `SubjectRoom` used
            // to null its brief, tab and expansion in an effect on
            // `[subjectKey]`, which the React compiler flags — a setState
            // called synchronously from an effect. React's own answer to
            // "reset all state when a prop changes" is the key, and it also
            // catches the state that reset forgot: selection, bulk-mode and
            // the bulk note stayed live across a subject change.
            <SubjectRoom
              key={room.key}
              subjectKey={room.key}
              model={model}
              work={work}
              totals={totals}
              looking={looking}
              inventory={inventory}
              lanes={lanes}
              subjectRecords={subjectRecords}
              onOpenItem={openItem}
              onNight={() => openFace({ kind: "night" })}
              onPermits={() => openFace({ kind: "permits" })}
              onSuggest={suggest}
              onAck={acknowledge}
              onAckAll={acknowledgeAll}
              onSettle={askSettle}
              onSettleAll={askSettleAll}
              onCloseItem={closeByHand}
              onReopenItem={reopenByHand}
              onPinItem={pinByHand}
              closeNote={closeNote}
              onOpenNote={(id) => openFace({ kind: "note", id })}
              onNewNote={(subjectKey) => openFace({ kind: "note-new", ...(subjectKey ? { subjectKey } : {}) })}
              onChanged={load}
              onLeaveRoom={goLobby}
              onEditItem={editByHand}
            />
          )}

          {/* THE ASSISTANT'S OTHER DOOR — §13.6. The same conversation the
              layer's chat slot holds, full-width: no `onExpand` (nowhere
              further to expand to) and no `onClose` (nothing hosting it to
              close from inside). */}
          {room.kind === "assistant" && (
            <MasterChat onChanged={load} openers={openers} prefill={suggestion} context={viewContext} variant="room" />
          )}

          {/* AN AREA PAGE — §13.8. The SAME `Lobby` component, scoped: its
              own `areaPath` prop swaps the two tiles and the whole tree for
              a breadcrumb and one subtree, so the container grammar (and
              every drag/rename/reorder/ceiling gesture riding on it) never
              has a second implementation to drift from the home screen's. */}
          {room.kind === "area" && (
            <Lobby
              areaPath={room.path}
              onEnterSubject={goSubject}
              onChanged={load}
              onEnterArea={goArea}
              onEnterLobby={goLobby}
            />
          )}

          {/* THE SETTLE DIALOG — the only site that writes a settle, and it
              SHOWS the answer before recording it. The body is honest about
              what settling is: writing down what was found out, never marking
              something over. The input starts as the observation's own words
              and stays the human's to edit; confirm is the one send. */}
          <ConfirmDialog
            open={!!settling}
            onOpenChange={(next) => !next && setSettling(null)}
            title="Settle this thread?"
            body={
              <>
                “{clip(settling?.title ?? "", 80)}” stays on the record, settled, with this answer — settling records
                what was found out, not that it is over:
                <Input
                  value={settleAnswer}
                  onChange={(event) => setSettleAnswer(event.target.value)}
                  aria-label="The answer that will be recorded"
                  className="mt-2 text-xs md:text-xs"
                />
              </>
            }
            confirmLabel="Settle"
            busy={settleBusy}
            error={settleError}
            onConfirm={confirmSettle}
          />

          {/* THE SETTLE-ALL DIALOG — ONE dialog for the whole answered
              slice, and the only site that writes the bulk settle. Each row
              SHOWS the answer that will be recorded — the confrontation
              observation's stored words, the existing composition — before
              the one confirm; a row the store refuses comes back beside the
              ones that landed and renders verbatim after. Never auto. */}
          <ConfirmDialog
            open={!!settlingMany}
            onOpenChange={(next) => !next && setSettlingMany(null)}
            title={`Settle ${settlingMany?.length ?? 0} answered ${settlingMany && settlingMany.length === 1 ? "thread" : "threads"}?`}
            body={
              <>
                The world already answered these — each stays on the record, settled, with the answer shown. Settling
                records what was found out, not that it is over:
                <span className="mt-2 block space-y-1.5">
                  {(settlingMany ?? []).map((row) => (
                    <span key={row.threadId} className="block text-xs leading-relaxed">
                      <span className="block truncate font-medium text-foreground">“{clip(row.title, 70)}”</span>
                      <span className="block text-muted-foreground">{row.answer}</span>
                    </span>
                  ))}
                </span>
              </>
            }
            confirmLabel="Settle them all"
            busy={settleManyBusy}
            error={settleManyError}
            onConfirm={confirmSettleMany}
          />
        </main>

        {/* THE SUMMONED LAYER — §13.6. ONE overlay, ONE slot, conversation XOR
            a face, docked to the right edge and SLID OVER the room's content
            rather than pushing it narrower — `absolute`, not a flex sibling,
            inside the `relative` row above. It paints its own background —
            the RAIL token, a real ground step off the canvas in both schemes
            — so it reads as furniture with an edge, and the room's ground
            does not bleed through underneath it. Above the room's content,
            below any dialog (`ConfirmDialog` portals higher). No path renders
            this AND a resident chat aside at the same time — there is no
            resident chat aside any more; the Assistant room is where the
            same conversation goes full-width instead. */}
        {layer && (
          <div className="absolute inset-y-0 right-0 z-20 flex w-96 min-w-80 shrink-0 flex-col border-l border-border bg-sidebar shadow-3">
            {layer.kind === "chat" ? (
              <MasterChat
                onChanged={load}
                openers={openers}
                prefill={suggestion}
                context={viewContext}
                onExpand={() => {
                  goAssistant();
                  setLayer(null);
                }}
                onClose={() => setLayer(null)}
              />
            ) : (
              <SpoolTray
                face={layer.face}
                work={work}
                subjects={subjectRecords}
                lanes={lanes}
                map={map}
                onOpenItem={openItem}
                onOpenNote={(id) => openFace({ kind: "note", id })}
                onNewNote={(subjectKey) => openFace({ kind: "note-new", ...(subjectKey ? { subjectKey } : {}) })}
                onClose={() => setLayer(null)}
                onChanged={load}
                onBackToChat={() => setLayer({ kind: "chat" })}
                onExpand={() => {
                  goAssistant();
                  setLayer(null);
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
