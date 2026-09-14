"use client";

/**
 * THE CREDENTIAL BOUNDARY, SAID OUT LOUD (#480).
 *
 * While a person is entering credentials, the shell pauses EVERY agent browser
 * tool in EVERY session — reads and mutations alike (private-interaction.js).
 * That is right, and it was invisible: the only place it was ever mentioned was
 * inside the error an agent got back, which a person reading the panel never
 * sees. When the automatic release then wedged, the browser was simply dead in
 * every session at once and the only cure anybody found was killing Telar.
 *
 * So the pause is drawn where the pause is: a slim bar over the tab strip, in
 * every panel, because the boundary really is global — the sign-in holding your
 * session's tools open may be in a different session's window, which is why the
 * bar NAMES the page that holds it.
 *
 * TWO BUTTONS, AND THE SECOND ONE IS THE POINT. Resume re-runs the shell's own
 * safety probe and is refused unless the holding page answers clean — that
 * probe is what keeps an agent from reading a half-typed password. A page that
 * will not answer AT ALL cannot be cleared that way, and the only remaining
 * witness to whether the sign-in is over is the person looking at it: Resume
 * anyway is them saying so. It appears only after the ordinary Resume has been
 * refused, never before, and the shell logs that it was used.
 *
 * NOTHING HERE CALLS THE BRIDGE — the browser panel owns it, the same split
 * `browser-permission-prompt.tsx` uses.
 */

import { useState } from "react";
import { LockIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The credential boundary, as the shell reports it (private-interaction.js +
 *  the manager's `privacyState`). */
export type DesktopPrivacyState = {
  private: boolean;
  epoch: number;
  reason?: string;
  since?: number;
  scopeKey?: string | null;
  refused?: string;
  /** The automatic release has been unable to reach the holding page for long
   *  enough that a person should be offered a way out. */
  stuck?: boolean;
  /** The tabs whose own preload reported a credential field. A HOST or a title,
   *  never a full address — a sign-in URL carries tokens in its query. */
  holding?: readonly { id: string; label: string }[];
};

/** The pages holding the window, as one phrase — or null when the shell did not
 *  name any (an older shell, or a hold whose tab has already gone). */
export function namePrivacyHolders(holding: DesktopPrivacyState["holding"]): string | null {
  if (!holding?.length) return null;
  const [first, ...rest] = holding;
  if (!rest.length) return first!.label;
  return `${first!.label} and ${rest.length} other page${rest.length === 1 ? "" : "s"}`;
}

export type PrivacyBannerCopy = {
  tone: "info" | "warn";
  headline: string;
  /** What a person can do about it, or null while the release is expected to
   *  happen on its own and there is genuinely nothing to do. */
  hint: string | null;
};

/**
 * What the bar says. The two states are NOT two degrees of the same warning:
 * "a sign-in is in progress" is the system working, and asks for nothing; "the
 * page is not answering" is the system stuck, and names the way out.
 */
export function describePrivacy(privacy: DesktopPrivacyState, canResume = true): PrivacyBannerCopy {
  const where = namePrivacyHolders(privacy.holding);
  if (privacy.stuck) {
    return {
      tone: "warn",
      headline: where ? `Browser tools are paused: ${where} is not answering.` : "Browser tools are paused: the sign-in page is not answering.",
      // The second clause is only true where a button is actually drawn — an
      // older shell has no resume door, and offering one in words is no better
      // than offering one that throws.
      hint: canResume
        ? "Reload or close that page and they resume on their own, or resume them here."
        : "Reload or close that page and they resume on their own.",
    };
  }
  return {
    tone: "info",
    headline: where ? `Browser tools are paused: a sign-in is in progress on ${where}.` : "Browser tools are paused: a sign-in is in progress.",
    hint: null,
  };
}

export function BrowserPrivacyBanner({
  privacy,
  onResume,
  className,
}: {
  privacy: DesktopPrivacyState;
  /** Ends the private window. Without `force` the shell re-probes and may
   *  refuse; with it, the person's assertion stands. ABSENT on an older shell
   *  that has no such door — the bar then still says what is happening and
   *  offers nothing, rather than a button that cannot work. */
  onResume?: (options?: { force?: boolean }) => Promise<DesktopPrivacyState>;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  // The shell's own sentence for why the last Resume did not go through. Its
  // presence is ALSO what earns the second button: "Resume anyway" is offered
  // to somebody who has already tried the safe path and been told no.
  const [refusal, setRefusal] = useState<string>();
  const copy = describePrivacy(privacy, Boolean(onResume));

  const resume = async (force: boolean) => {
    if (!onResume) return;
    setBusy(true);
    try {
      const next = await onResume(force ? { force: true } : undefined);
      setRefusal(next.private ? (next.refused ?? "The browser is still handling a sign-in.") : undefined);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : "Could not resume browser tools.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-2xs",
        copy.tone === "warn" ? "border-warning/40 bg-warning/10 text-foreground" : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      {copy.tone === "warn" ? (
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-warning" />
      ) : (
        <LockIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <p>{copy.headline}</p>
        {/* The refusal replaces the generic hint: it is the same page, said
            more precisely, and two sentences about one thing is a paragraph. */}
        {refusal ? <p className="mt-0.5 text-warning">{refusal}</p> : copy.hint ? <p className="mt-0.5">{copy.hint}</p> : null}
      </div>
      {/* NO BUTTON WHILE IT IS MERELY IN PROGRESS. The release is automatic and
          arrives within a poll of the person finishing; a button there would
          invite somebody to click through their own sign-in. */}
      {privacy.stuck && onResume ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void resume(false)}>
            Resume
          </Button>
          {refusal ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void resume(true)}>
              Resume anyway
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
