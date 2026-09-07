"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { attachmentUrl } from "@/lib/ds";

/** One plot, large. Opened from a cell output, the gallery, or the transcript. */
export function ImageLightbox({ sessionId, attachmentId, onClose }: { sessionId: string; attachmentId?: string; onClose: () => void }) {
  return (
    <Dialog open={Boolean(attachmentId)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[min(90vw,1200px)]">
        <DialogTitle className="sr-only">Figure</DialogTitle>
        {attachmentId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={attachmentUrl(sessionId, attachmentId)} alt="Figure" className="max-h-[80vh] w-full rounded bg-white object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}
