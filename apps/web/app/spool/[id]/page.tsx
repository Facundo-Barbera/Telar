import { redirect } from "next/navigation";

/**
 * THE PACKET PAGE IS A DEEP LINK NOW — §13.4. The room's tray renders the
 * packet, so this route's one job is to land an old URL in the room with the
 * tray open on the right item. A redirect rather than a render, because two
 * surfaces for one packet is the Changes/Git mistake this app records having
 * made once already.
 */
export default async function PacketDeepLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/spool?item=${encodeURIComponent(id)}`);
}
