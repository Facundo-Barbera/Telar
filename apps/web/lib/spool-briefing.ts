/**
 * The first message a session opens with when a packet is handed to it.
 *
 * Ported from `apps/web_old/lib/session-briefing.ts`.
 *
 * "AT EXECUTION TIME THE PACKET *IS* THE BRIEFING — nothing is re-authored for
 * handoff." So this composes, it does not write: every line below is a field off
 * the packet, in the register of a first message to a colleague. If you find
 * yourself adding a sentence here that is not on the packet, the packet is what
 * is missing it.
 *
 * PURE AND IMPORT-FREE. It is called from a client component and written
 * straight into the composer's draft key before navigating, so nothing here may
 * reach for the engine.
 */
import type { SpoolAttachmentTally, SpoolItem } from "@telar/engine-client";

export type BriefingPacket = Pick<SpoolItem, "id" | "title"> &
  Partial<Pick<SpoolItem, "raw" | "fixed" | "acceptance" | "subtasks" | "project">> & {
    attachments?: SpoolAttachmentTally;
  };

export const bullets = (lines: string[]): string => lines.map((l) => `- ${l}`).join("\n");

function attachmentLine(a: SpoolAttachmentTally): string | null {
  const parts: string[] = [];
  if (a.files > 0) parts.push(`${a.files} file${a.files === 1 ? "" : "s"}`);
  if (a.mockups > 0) parts.push(`${a.mockups} mockup${a.mockups === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;
  // NAMED, NOT ATTACHED. The bytes live beside the packet, outside every
  // session's working root, and a composer draft cannot carry a file — pretending
  // otherwise would have the session hunt for an upload that never happened.
  //
  // The verb agrees with the TOTAL, not with the number of clauses: one file and
  // no mockups reads "1 file sit beside the packet" until this counts.
  const verb = a.files + a.mockups === 1 ? "sits" : "sit";
  return `${parts.join(" + ")} ${verb} beside the packet in the spool.`;
}

export function spoolBriefing(packet: BriefingPacket): string {
  const brief = packet.fixed?.trim() || packet.raw?.trim() || "";
  // WHICH WORDS THESE ARE, said up front. A ripened brief and a raw capture read
  // very differently to whoever picks this up, and mislabelling the second as the
  // first is how an expert's drift becomes invisible.
  const open = packet.fixed?.trim()
    ? "Working this packet from my spool — the brief below is the ripened one."
    : "Working this packet from my spool — it is still a raw capture, so the brief below is my own words as I wrote them down.";

  const out: string[] = [open, "", `## ${packet.title}`];
  if (brief) out.push("", brief);
  if (packet.acceptance?.length) out.push("", "Acceptance criteria:", bullets(packet.acceptance));
  const open_ = (packet.subtasks ?? []).filter((s) => !s.done);
  if (open_.length) out.push("", "Sub-tasks already broken out:", bullets(open_.map((s) => s.title)));

  const trailer = [`spool item \`${packet.id}\``];
  const attachments = packet.attachments ? attachmentLine(packet.attachments) : null;
  if (attachments) trailer.push(attachments);
  out.push(
    "",
    "---",
    "",
    trailer.join(" · "),
    // The moat, said out loud to the session about to read this. The packet is
    // not this session's to close — only a human accepts.
    "The packet stays in my spool while we work; closing it is mine to do, not yours.",
  );
  return out.join("\n");
}
