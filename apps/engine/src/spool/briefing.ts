/**
 * BRIEFED ARRIVAL — loop 2's payload, composed and handed over.
 *
 * "'Work on this' lands the user in a real Telar session that is already
 * briefed: the packet, the raw words, the dependency chain, and the delta
 * since the user's last look, injected as opening context."
 *
 * ── THE ENGINE COMPOSES; THE WEB DELIVERS; THE HUMAN SENDS ──────────────────
 * This file creates no session and queues no turn. The web already has the
 * delivery mechanism — the briefing becomes a composer DRAFT in the target
 * project's new-session page, and nothing runs until the human presses send.
 * That is not a compromise: it is the moat. What was missing was the CONTENT —
 * the web's client-side composer only had the packet, and the packet alone is
 * the stale snapshot the user said they could not trust. This composition adds
 * the thread state and the look delta, from the store, in one read.
 *
 * ── DETERMINISTIC, AND THE CLOCK LAW HOLDS ──────────────────────────────────
 * Pure string composition over stored data — no model call. Every time that
 * appears in the text is a QUOTE of a stored label with its attribution
 * ("captured Tue 16:42", "as of the Spool's look at Sat 07:40"), which is
 * exactly what §3.2 permits and nothing more.
 */
import type {
  SpoolBriefing,
  SpoolItem,
  SpoolLook,
  SpoolObservation,
  SpoolSubject,
  SpoolThread,
} from "@telar/engine-client";

const section = (heading: string, body: string): string => `## ${heading}\n${body}`;

const quote = (raw: string): string =>
  raw
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const bullets = (rows: readonly string[]): string => rows.map((row) => `- ${row}`).join("\n");

/** A thread, as one line the session can act on: what is not known, who it is
 *  stuck on, or what settled it. */
function threadLine(thread: SpoolThread): string {
  const name = thread.handle ?? thread.question;
  if (thread.settled) return `${name} — settled: ${thread.settled.answer}`;
  const stuck = thread.waiting
    ? thread.waiting.kind === "person"
      ? ` (stuck on ${thread.waiting.who ?? "a person"}${thread.waiting.note ? ` — ${thread.waiting.note}` : ""})`
      : thread.waiting.kind === "you"
        ? ` (stuck on the user${thread.waiting.note ? ` — ${thread.waiting.note}` : ""})`
        : ` (stuck on an agent${thread.waiting.note ? ` — ${thread.waiting.note}` : ""})`
    : "";
  return `Open: ${thread.question}${stuck}`;
}

/**
 * COMPOSE THE BRIEFING for one item. Everything optional degrades to a smaller
 * briefing rather than a hole: a terrain-less subject simply has no freshness
 * section, a floating item has no subject line, an unripened capture is its
 * own words and nothing else — the no-code test, applied to prose.
 */
export function composeBriefing(input: {
  item: SpoolItem;
  /** The subject's threads that hold this item. */
  threads?: readonly SpoolThread[];
  look?: SpoolLook;
  subject?: SpoolSubject;
  project?: { id: string; name: string };
}): SpoolBriefing {
  const { item, subject, project, look } = input;
  const threads = input.threads ?? [];
  const parts: string[] = [];

  parts.push(
    [
      `You are picking up a prepared piece of work from the user's Spool.`,
      ``,
      `# ${item.title}`,
      subject
        ? `Subject: ${subject.name === subject.key ? subject.key : `${subject.name} (${subject.key})`}${
            subject.terrain ? ` — lives in ${subject.terrain.repo}` : ""
          }`
        : `Subject: none yet — this capture is floating.`,
      `Captured ${item.captured} (provenance: ${item.provenance}).${item.mirrored ? ` Mirrors ${item.mirrored} in a foreign tracker.` : ""}`,
      ...(item.deadline ? [`Deadline, as its source states it: "${item.deadline.label}" (${item.deadline.kind}).`] : []),
      // A quiet quote of the user's own placement — never "due", never a
      // countdown, and no comparison against today anywhere near it.
      ...(item.pinned ? [`The user pinned this to ${item.pinned.day}.`] : []),
    ].join("\n"),
  );

  if (subject?.terrain?.notes) parts.push(section("What the user said about this terrain", subject.terrain.notes));

  if (item.raw) {
    parts.push(
      section(
        `In the user's own words${item.rawSource ? ` (${item.rawSource})` : ""}`,
        quote(item.raw),
      ),
    );
  }

  parts.push(
    section(
      "The brief",
      item.fixed ?? "No brief has been written yet — the user's words above are everything there is.",
    ),
  );
  if (item.acceptance?.length) parts.push(section("Acceptance criteria", bullets(item.acceptance)));
  if (item.draft) parts.push(section("A proposed approach (agent-written; nobody has reviewed it)", item.draft));
  if (item.openQuestions?.length) {
    parts.push(section("Questions the preparation could not answer alone", bullets(item.openQuestions)));
  }
  if (item.commitments?.length) {
    parts.push(
      section(
        "Commitments heard in the capture",
        bullets(item.commitments.map((commitment) => `"${commitment.text}" — ${commitment.when}`)),
      ),
    );
  }
  if (item.subtasks?.length) {
    parts.push(
      section(
        "Sub-tasks",
        bullets(item.subtasks.map((subtask) => `${subtask.done ? "[done]" : "[open]"} ${subtask.title}`)),
      ),
    );
  }

  const mine = threads.filter((thread) => thread.items.includes(item.id));
  if (mine.length > 0) parts.push(section("Threads this capture feeds", bullets(mine.map(threadLine))));

  /**
   * HOW IT RIPENED — the tail of the timeline, so the session knows what has
   * already been done to these words and by whom. The tail rather than the
   * whole: a briefing is an arrival, not an archive, and the packet stays one
   * click away with everything.
   */
  const timeline = item.timeline ?? [];
  if (timeline.length > 0) {
    parts.push(
      section(
        "How it got here",
        bullets(
          timeline
            .slice(-5)
            .map((event) => `[${event.at} · ${event.actor}] ${event.text}${event.proposal ? " (proposal — unreviewed)" : ""}`),
        ),
      ),
    );
  }

  /** The delta half — unacknowledged only: what was already noted is already
   *  known, and repeating it is how a briefing becomes noise. */
  const fresh: SpoolObservation[] = (look?.observations ?? []).filter((observation) => !observation.acknowledged);
  if (look) {
    parts.push(
      section(
        `As of the Spool's look at ${look.lastLooked}`,
        fresh.length > 0 ? bullets(fresh.map((observation) => observation.text)) : "Nothing had moved since the previous look.",
      ),
    );
  } else if (subject?.terrain) {
    parts.push(section("Freshness", "The Spool has not looked at this subject's terrain yet — check the tracker yourself."));
  }

  parts.push(
    "Nothing above has been started, sent or accepted. It is preparation. The user decides what happens next.",
  );

  return {
    itemId: item.id,
    title: item.title,
    ...(item.project ? { subject: item.project } : {}),
    ...(project ? { project } : {}),
    briefing: parts.join("\n\n"),
    ...(look ? { freshness: { looked: look.lastLooked, observations: fresh } } : {}),
  };
}
