"use client";

import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { attachmentUrl } from "./ds";

export function ImageLightbox({ sessionId, attachmentId, alt = "Figure", onClose }: { sessionId: string; attachmentId?: string; alt?: string; onClose: () => void }) {
  return (
    <Dialog open={Boolean(attachmentId)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[min(90vw,1200px)]">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {attachmentId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={attachmentUrl(sessionId, attachmentId)} alt={alt} className="max-h-[80vh] w-full rounded bg-white object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}
