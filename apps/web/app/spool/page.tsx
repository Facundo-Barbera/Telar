import { SpoolStance } from "@/components/spool/stance";

/**
 * The Spool's front door.
 *
 * `/spool` IS THE ROOM — stance, tray, conversation — §13 of
 * `docs/spool-definition.md`, after both earlier front doors failed the same
 * way: a chat-first page made the state invisible, and a data-first page made
 * the assistant invisible. One screen answers the three questions a person
 * actually arrives with — what needs me, what is being handled, what happened
 * while I was gone — and the chat stands beside it as the way to talk back.
 *
 * `?item=` IS THE DEEP LINK'S LANDING — `/spool/[id]` redirects here so an old
 * packet URL opens the room with the tray already on that packet, instead of a
 * second page the room would then have to compete with. Read server-side and
 * passed as a prop, per the file convention: the param loads the page's
 * opening state, which is exactly the case the docs give the prop to.
 */
export const dynamic = "force-dynamic";

export default async function SpoolPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string | string[] }>;
}) {
  const { item } = await searchParams;
  const id = Array.isArray(item) ? item[0] : item;
  return <SpoolStance {...(id ? { initialItem: id } : {})} />;
}
