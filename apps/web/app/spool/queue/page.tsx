import { QueueView } from "@/components/spool/queue-view";

/**
 * The queue — the drawer behind the front door.
 *
 * A STATIC SEGMENT BESIDE `[id]`, and the two cannot collide in practice: item
 * ids are minted `i-<hex>` and Next resolves a literal segment ahead of a
 * dynamic one regardless. `/spool/queue` is therefore reserved, which is the
 * cost of naming the drawer, and it is a name no item can take.
 */
export const dynamic = "force-dynamic";

export default function SpoolQueuePage() {
  return <QueueView />;
}
