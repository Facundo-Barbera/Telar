import { MasterChat } from "@/components/spool/master-chat";

/**
 * The Spool's front door.
 *
 * `/spool` IS THE MASTER CHAT, as the Shell always said it would be — the queue
 * moved down to `/spool/queue`, which is the drawer behind it. It stood at the
 * root only while the project-less session did not exist, and landing the
 * destination on the half that worked was better than landing it on a blank
 * screen.
 *
 * THE ORDER IS THE ARGUMENT. Arriving at a queue teaches that this is a task
 * list you maintain; arriving at a conversation teaches that it is something you
 * talk to and the list is what it remembers. Same two surfaces, opposite
 * products.
 */
export const dynamic = "force-dynamic";

export default function SpoolPage() {
  return <MasterChat />;
}
