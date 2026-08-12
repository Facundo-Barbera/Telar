// "Start a session instead" — the OTHER handoff, and the one CAP-11 insists is
// equal-weight rather than a fallback: "a single ripened packet handed to a
// session". A session takes no bundle and no objective.md; what it takes is a
// first message. This composes it.
//
// WHY IT IS NOT workspace-handoff.ts's premise. objective.md is a contract a
// loom weaves against — headings, a boundary clause, criteria the loom must
// meet. A session opener is a person's first sentence to a colleague: the same
// FACTS (the packet's own `fixed`/`raw`, its criteria, its sub-tasks — nothing
// re-authored, item-model.md), in the register of a chat. Sharing one composer
// between them would force one of the two to read wrong; sharing the SOURCE
// FIELDS, which is what actually matters, costs nothing.
//
// PURE AND IMPORT-FREE (bar a type). The packet view is a client component and
// writes this straight into the composer's draft key
// (`telar:draft:new:<project>`, components/session/composer-draft.tsx) before
// navigating — so nothing here may reach for @telar/core, which is server-only.
//
// NOTHING IS ACCEPTED AND NOTHING MOVES. Unlike the weave, this writes no
// `tracking` mark: a session is a conversation, not a unit of work with a
// lifecycle to track, so there is nothing for the row to point at. The packet
// stays exactly where it is, and the closing line says so to the session.
import type { Item } from "@telar/core";

export type BriefingPacket = Pick<Item, "id" | "title"> &
  Partial<Pick<Item, "raw" | "fixed" | "acceptance" | "subtasks" | "project">> & {
    attachments?: { files: number; mockups: number };
  };

// Exported, and lib/workspace-handoff.ts imports it rather than keeping the
// byte-identical one-liner it used to have. The direction is forced: that module
// pulls in @telar/core (server-only) and this one is rendered from a client
// component, so the shared helper has to live on the pure side of the line.
export const bullets = (lines: string[]): string => lines.map((l) => `- ${l}`).join("\n");

function attachmentLine(a: { files: number; mockups: number }): string | null {
  const parts: string[] = [];
  if (a.files > 0) parts.push(`${a.files} file${a.files === 1 ? "" : "s"}`);
  if (a.mockups > 0) parts.push(`${a.mockups} mockup${a.mockups === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;
  // NAMED, NOT ATTACHED. The bytes live beside the packet and the session can
  // read them; a composer draft cannot carry a file, and pretending otherwise
  // would have the session look for an upload that never happened.
  //
  // The verb agrees with the TOTAL, not with the number of clauses: one file and
  // no mockups read "1 file sit beside the packet" until this counted.
  const verb = a.files + a.mockups === 1 ? "sits" : "sit";
  return `${parts.join(" + ")} ${verb} beside the packet in the workspace.`;
}

export function sessionBriefing(packet: BriefingPacket): string {
  const brief = packet.fixed?.trim() || packet.raw?.trim() || "";
  const open = packet.fixed?.trim()
    ? "Working this packet from my workspace queue — the brief below is the ripened one."
    : "Working this packet from my workspace queue — it is still a raw capture, so the brief below is my own words as I wrote them down.";

  const out: string[] = [open, "", `## ${packet.title}`];
  if (brief) out.push("", brief);
  if (packet.acceptance?.length) {
    out.push("", "Acceptance criteria:", bullets(packet.acceptance));
  }
  const open_ = (packet.subtasks ?? []).filter((s) => !s.done);
  if (open_.length) {
    out.push("", "Sub-tasks already broken out:", bullets(open_.map((s) => s.title)));
  }

  const trailer = [`workspace item \`${packet.id}\``];
  const attachments = packet.attachments ? attachmentLine(packet.attachments) : null;
  if (attachments) trailer.push(attachments);
  out.push(
    "",
    "---",
    "",
    trailer.join(" · "),
    // The moat, said out loud to the session that is about to read this. The
    // packet is not this session's to close — only a human accepts (AD-8).
    "The packet stays in my queue while we work; closing it is mine to do, not yours.",
  );
  return out.join("\n");
}
