"use client";

import { useMemo, useState } from "react";
import { AlarmClockIcon, CircleCheckIcon, FoldVerticalIcon } from "lucide-react";
import { contextNoticeDue } from "../context-notice";
import { fmtTokens } from "@/ui/format";
import { contextNoticeDismissal, writeContextNoticeDismissed } from "../context-notice-dismissal";
import { ComposerBanner } from "./composer-chrome";
import type { ComposerProps } from "./composer-props";

type BannerProps = Pick<
  ComposerProps,
  "fresh" | "session" | "settled" | "settledEnded" | "onUnsettle" | "snoozeWakeIn" | "onWake" | "usage" | "onCompact" | "compacting" | "contextNoticePercent"
>;

/** Settled, snoozed and heavy-context notices, back to front. Settled and snoozed never both apply. */
export function ComposerBanners({ fresh, session, settled, settledEnded, onUnsettle, snoozeWakeIn, onWake, usage, onCompact, compacting, contextNoticePercent }: BannerProps) {
  const heavy = Boolean(!fresh && session && onCompact && !compacting && contextNoticeDue(usage, contextNoticePercent));
  // The press that storage has not been re-read for yet, so the banner goes away on the same render.
  const [dismissedNow, setDismissedNow] = useState<string>();
  const dismissed = useMemo(
    () => contextNoticeDismissal({ sessionId: session?.id, heavy, ...(dismissedNow ? { justDismissed: dismissedNow } : {}) }),
    [session?.id, heavy, dismissedNow],
  );
  if (fresh || !session) return null;

  return (
    <>
      {settled && (
        <ComposerBanner
          icon={<CircleCheckIcon className="size-4 shrink-0 text-muted-foreground" />}
          title="This conversation is settled"
          detail={`${settledEnded ? `${settledEnded} ` : ""}Sending a message returns it to the list in the sidebar.`}
          {...(onUnsettle ? { action: onUnsettle, actionLabel: "Un-settle" } : {})}
        />
      )}
      {snoozeWakeIn && (
        <ComposerBanner
          icon={<AlarmClockIcon className="size-4 shrink-0 text-muted-foreground" />}
          title="This conversation is snoozed"
          detail={`It comes back to the list in ${snoozeWakeIn}, or as soon as it answers you.`}
          {...(onWake ? { action: onWake, actionLabel: "Wake now" } : {})}
        />
      )}
      {heavy && !dismissed && onCompact && (
        <ComposerBanner
          icon={<FoldVerticalIcon className="size-4 shrink-0 text-muted-foreground" />}
          title="The context is getting heavy"
          detail={`${fmtTokens(usage?.contextUsed ?? 0)} of ${fmtTokens(usage?.contextMax ?? 0)} tokens in the provider's window.`}
          action={onCompact}
          actionLabel="Compact"
          onDismiss={() => {
            writeContextNoticeDismissed(session.id);
            setDismissedNow(session.id);
          }}
        />
      )}
    </>
  );
}
