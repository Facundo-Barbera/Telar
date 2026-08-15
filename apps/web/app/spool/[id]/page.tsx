import { PacketView } from "@/components/spool/packet-view";

export const dynamic = "force-dynamic";

/** One item's packet — its raw fragment, the brief that replaced it, what it
 *  gathered, its ripening timeline, and the handoff at the end. */
export default async function PacketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PacketView id={id} />;
}
