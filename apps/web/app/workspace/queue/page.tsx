import { QueueView } from "@/components/workspace/queue-view";

// THE DRAWER BEHIND THE FRONT DOOR (ui-contract.md "Shell", story 5.7).
//
// The queue used to BE `/workspace`. It is not the destination — chat is:
// "Workspace is one top-level destination with two tabs — Chat (front door)
// and Queue (the drawer behind it). The queue does not pretend to be its own
// destination." So the root renders the master now and this is its second tab.
//
// ITEM DEEP LINKS ARE UNTOUCHED, which was the story's own constraint on this
// move: `/workspace/<id>` still resolves to the packet view, and this static
// `queue` segment can never shadow one — Next resolves a static segment ahead
// of a dynamic one, and item ids are minted `i-<12 hex>`
// (packages/core/src/workspace/store.ts), so no item can be addressed "queue".
export default function WorkspaceQueuePage() {
  return <QueueView />;
}
