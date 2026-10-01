"use client";

import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";

export function ImageLightbox({ src, alt = "Figure", onClose, onError }: { src?: string; alt?: string; onClose: () => void; onError?: () => void }) {
  return (
    <Dialog open={Boolean(src)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-auto min-w-48 sm:max-w-[min(90vw,1200px)]">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt} onError={onError} className="mx-auto block max-h-[80vh] min-h-16 max-w-full min-w-16 rounded bg-white object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}
