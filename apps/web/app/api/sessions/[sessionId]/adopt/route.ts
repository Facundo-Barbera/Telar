import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

/**
 * ADOPT A CLAUDE CODE CONVERSATION INTO THIS SESSION — `/resume`, #616.
 *
 * The session's next turn continues the adopted conversation, and its history
 * becomes readable in the cockpit. What is NOT touched is the person's own
 * Claude Code history: Telar forks rather than resuming in place, and the
 * engine asserts the original was untouched rather than trusting that it was.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const input = await requestObject(request);
    return Response.json(
      await (await engineClient()).adoptClaudeConversation(sessionId, {
        sourceSessionId: String(input.sourceSessionId ?? ""),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
