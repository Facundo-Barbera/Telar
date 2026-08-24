import { LoomGraph } from "./loom-graph";

export const dynamic = "force-dynamic";

export default async function LoomGraphPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LoomGraph loomId={id} />;
}
