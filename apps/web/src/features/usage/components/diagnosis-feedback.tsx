"use client";

import { useEffect, useMemo, useState } from "react";
import type { UsageDiagnosis } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { openInSystemBrowser } from "@/platform/link-policy";
import { isHostWindow } from "@/platform/desktop/host-window";
import { Button } from "@/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { describeSystem, feedbackIssue } from "@/features/updates";
import { diagnosisFeedbackText } from "../diagnosis-feedback";

const api = createEngineApi();

export function SendDiagnosisFeedback({ diagnosis }: { diagnosis: UsageDiagnosis }) {
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState<{ appVersion: string; channel: string }>();

  useEffect(() => {
    if (!open || about) return;
    void api.about().then(setAbout).catch(() => undefined);
  }, [open, about]);

  const issue = useMemo(
    () =>
      feedbackIssue(diagnosisFeedbackText(diagnosis), {
        version: about?.appVersion,
        channel: about?.channel,
        system: describeSystem(navigator.userAgent),
        connection: isHostWindow() ? "local" : "remote",
      }),
    [diagnosis, about],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Send as feedback
      </Button>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Send the diagnosis as feedback</DialogTitle>
          <DialogDescription>This exact text becomes a public issue. Session names, paths and prompts are already removed.</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{issue.title}</p>
        <textarea
          aria-label="Issue text"
          readOnly
          value={issue.body}
          rows={14}
          className="w-full resize-none rounded-md border border-border bg-muted/40 p-2 font-mono text-xs outline-none"
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            onClick={() => {
              openInSystemBrowser(issue.url);
              setOpen(false);
            }}
          >
            Open issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
