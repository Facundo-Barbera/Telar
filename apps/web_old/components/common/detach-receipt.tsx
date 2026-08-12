// The ONE renderer of the detach receipt (lib/detach-receipt.ts composes the
// words; this draws them). Shared by all three surfaces that detach a loom —
// the birth session's transcript, the packet's "Its turn came", the queue's
// batch bar — because CAP-11 says the line is "identical whether it fires from
// a birth session, the queue's batch weave, or a packet's handoff", and two
// renderers with the same string in them is a promise, not a mechanism.
//
// NOT A CLIENT COMPONENT AND NOT A SERVER ONE: it holds no state and calls no
// hook, so it inherits whichever context imports it. The queue and packet views
// are already "use client"; the session transcript is too.
//
// TOKENS ONLY. The demo's `text-emerald-600 dark:text-emerald-400` is
// `text-success` here (ui-contract.md's bridged token set), and the hue is on
// the ICON only — the words stay muted, which is the frozen chip grammar
// applied to a receipt.
import { CircleCheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { detachReceiptLine, type DetachReceipt as DetachReceiptData } from "@/lib/detach-receipt";

export function DetachReceipt({
  receipt,
  className,
  // The queue's batch bar renders inside a floating card that already has its
  // own border and shadow; the packet and the session mount it as a card of its
  // own. One flag rather than two components, so the LINE cannot diverge.
  bare,
}: {
  receipt: DetachReceiptData;
  className?: string;
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        "space-y-1.5",
        !bare && "rounded-lg border border-border bg-card p-3",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
        <p className="min-w-0 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {detachReceiptLine(receipt)}
        </p>
      </div>
      {receipt.note && (
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/60">
          {receipt.note}
        </p>
      )}
    </div>
  );
}
