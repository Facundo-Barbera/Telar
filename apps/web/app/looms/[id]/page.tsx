import { LoomRoom } from "./loom-room";

/**
 * The loom room — one loom, told in loom language: the objective, each
 * thread's contract, what it is doing right now, and the verification
 * evidence. The chat transcript is the escape hatch behind each thread,
 * never the story itself.
 */
export const dynamic = "force-dynamic";

export default async function LoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LoomRoom loomId={id} />;
}
