import { PacketView } from "@/components/workspace/packet-view";

export default async function WorkspaceItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PacketView id={id} />;
}
