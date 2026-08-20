import type { SpoolSubjectColor, SpoolTerrain } from "@telar/engine-client";
import { SpoolSubjectColor as SpoolSubjectColorEnum } from "@telar/engine-client";
import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ key: string }> };

/** `docs/spool-loops.md` §3's terrain, guarded before it can reach the engine:
 *  `null` clears (a corrected statement, not a deletion — the looks stay), and
 *  the one kind that exists today is a `gh`-addressable repo. */
function validTerrain(terrain: unknown): boolean {
  if (terrain === null) return true;
  if (typeof terrain !== "object" || terrain === null) return false;
  const t = terrain as { kind?: unknown; repo?: unknown; notes?: unknown };
  return (
    t.kind === "github-repo" &&
    typeof t.repo === "string" &&
    t.repo.length > 0 &&
    (t.notes === undefined || typeof t.notes === "string")
  );
}

/**
 * The THREE arms a human sets here, each not a preference — §7.6's `permits`
 * (`read` gates ripening and `draft` gates drafting, so lowering a subject
 * stops the night working it tonight), loops-§3's `terrain` (where the
 * subject lives in the world, which is what gives the Spool a place to look),
 * and loops-§8's IDENTITY (`area`, `color`, and — since the rail's own
 * drag-to-reorder pass, 2026-08-18 — `rank`: whose the subject is and where
 * the human put it by hand, never invented). Everything else about a subject
 * is derived. One arm per request — the arms are different statements, and a
 * body carrying two would leave a failure ambiguous about which landed —
 * except that `area`, `color`, and `rank` ride together, because the
 * engine's identity verb takes all three and any subset is the ordinary
 * call (the rail's reorder writes `rank` alone; a cross-area drop writes
 * `area` and `rank` together).
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { key } = await context.params;
    const body = await requestObject(request);
    if ("area" in body || "color" in body || "rank" in body) {
      // The identity arm — mirrors how terrain passes through: guarded here
      // in the same words the engine would refuse with, `null` clears (a
      // corrected statement, not a deletion), and the color set stays CLOSED:
      // a token from the engine's own enum, never free hex. `rank` clears the
      // same way — `null` says "no order stated", never a deletion of the
      // subject itself — and otherwise must be a finite number ≥ 0, the
      // rail's own 0..n-1 scheme, never a negative or fractional position.
      const { area, color, rank } = body as { area?: unknown; color?: unknown; rank?: unknown };
      if (area !== undefined && area !== null && typeof area !== "string") {
        return Response.json(
          { error: `area must be a string or null — got ${JSON.stringify(area)}.` },
          { status: 400 },
        );
      }
      if (color !== undefined && color !== null && !SpoolSubjectColorEnum.options.includes(color as SpoolSubjectColor)) {
        return Response.json(
          { error: `color must be one of ${SpoolSubjectColorEnum.options.join(", ")} or null — got ${JSON.stringify(color)}.` },
          { status: 400 },
        );
      }
      if (rank !== undefined && rank !== null && !(typeof rank === "number" && Number.isFinite(rank) && rank >= 0)) {
        return Response.json(
          { error: `rank must be a finite number >= 0, or null — got ${JSON.stringify(rank)}.` },
          { status: 400 },
        );
      }
      return Response.json(
        await (await engineClient()).setSpoolSubjectIdentity(key, {
          ...("area" in body ? { area: area as string | null } : {}),
          ...("color" in body ? { color: color as SpoolSubjectColor | null } : {}),
          ...("rank" in body ? { rank: rank as number | null } : {}),
        }),
      );
    }
    if ("terrain" in body) {
      const terrain = body.terrain;
      if (!validTerrain(terrain)) {
        return Response.json(
          { error: `terrain must be null or {kind:"github-repo", repo, notes?} — got ${JSON.stringify(terrain)}.` },
          { status: 400 },
        );
      }
      return Response.json(
        await (await engineClient()).setSpoolSubjectTerrain(key, terrain as SpoolTerrain | null),
      );
    }
    const permits = body.permits;
    if (permits !== "read" && permits !== "draft" && permits !== "propose") {
      return Response.json(
        { error: `permits must be "read", "draft" or "propose" — got ${JSON.stringify(permits)}.` },
        { status: 400 },
      );
    }
    return Response.json(await (await engineClient()).setSpoolSubjectPermits(key, permits));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
