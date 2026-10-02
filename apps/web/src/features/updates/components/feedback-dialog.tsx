"use client";

import { useEffect, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { createEngineApi } from "@/platform/engine";
import { openInSystemBrowser } from "@/platform/link-policy";
import { isHostWindow } from "@/platform/desktop/host-window";
import { Button } from "@/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { buildFeedbackUrl, describeSystem, type FeedbackInfo } from "../feedback";

const api = createEngineApi();

export function FeedbackDialog({ triggerClassName }: { triggerClassName: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [withInfo, setWithInfo] = useState(true);
  const [about, setAbout] = useState<{ appVersion: string; channel: string }>();

  useEffect(() => {
    if (!open || about) return;
    void api.about().then(setAbout).catch(() => undefined);
  }, [open, about]);

  const submit = () => {
    const info: FeedbackInfo | undefined = withInfo
      ? { version: about?.appVersion, channel: about?.channel, system: describeSystem(navigator.userAgent), connection: isHostWindow() ? "local" : "remote" }
      : undefined;
    openInSystemBrowser(buildFeedbackUrl(text, info));
    setOpen(false);
    setText("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" aria-label="Send feedback" onClick={() => setOpen(true)} className={triggerClassName}>
              <MessageSquareIcon className="size-4" />
            </button>
          }
        />
        <TooltipContent side="top">Send feedback</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>Opens a prefilled issue to review before you post it. Paste a screenshot into the issue if it helps.</DialogDescription>
        </DialogHeader>
        <textarea
          aria-label="Feedback"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={withInfo} onChange={(event) => setWithInfo(event.target.checked)} />
          Include version and system info
        </label>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={text.trim() === ""} onClick={submit}>
            Open issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
