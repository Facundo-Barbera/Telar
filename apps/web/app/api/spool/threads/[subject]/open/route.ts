import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * OPEN ONE QUESTION ON A SUBJECT'S MAP, deliberately — the hand's spelling of
 * the chat's `open a question` move (`docs/spool-loops.md` §9.4, the parity
 * rule: every verb the chat has, the hand gets as a visible control).
 *
 * Every law that binds a mapping pass binds this — at least one capture,
 * dedupe against restated questions — ENFORCED IN THE STORE, not here: a
 * refusal comes back as the engine's own sentence and the surface renders it
 * verbatim. The optional `waiting` arm rides the same open, so "mark this
 * waiting on María" from a packet with no thread yet is one write, not two.
 * Zero model calls on this path.
 */
export async function POST(request: Request, { params }: { params: Promise<{ subject: string }> }) {
  try {
    const { subject } = await params;
    const body = (await request.json()) as {
      question?: string;
      handle?: string;
      items?: string[];
      waiting?: { kind: "you" | "agent" | "person"; who?: string; note?: string };
    };
    if (typeof body.question !== "string" || body.question.trim() === "") {
      return Response.json(
        { error: "question is required — a thread is a question in your own words, never a status." },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return Response.json({ error: "items is required — a question is opened ON at least one capture." }, { status: 400 });
    }
    return Response.json(
      await (await engineClient()).openSpoolThread(subject, {
        question: body.question,
        items: body.items,
        ...(body.handle ? { handle: body.handle } : {}),
        ...(body.waiting ? { waiting: body.waiting } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
