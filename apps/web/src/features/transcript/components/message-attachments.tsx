"use client";

import { createContext, useContext, useState } from "react";
import { PaperclipIcon } from "lucide-react";
import type { TurnAttachment } from "@telar/engine-client";
import { attachmentUrl, ImageLightbox } from "@/features/plugins";

/** The session whose attachment route serves the files drawn below it. */
export const TranscriptSession = createContext<string | undefined>(undefined);

const CHIP = "flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-2xs text-muted-foreground";

export function MessageAttachments({ attachments }: { attachments?: readonly TurnAttachment[] }) {
  const sessionId = useContext(TranscriptSession);
  const [open, setOpen] = useState<TurnAttachment>();
  if (!attachments?.length) return null;
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {attachments.map((attachment) => (
          <li key={attachment.id}>
            {!sessionId ? (
              <span title={attachment.path} className={CHIP}>
                <PaperclipIcon className="size-3 shrink-0" />
                <span className="max-w-48 truncate">{attachment.name}</span>
              </span>
            ) : attachment.mediaType.startsWith("image/") ? (
              <button
                type="button"
                aria-label={`Open ${attachment.name}`}
                title={attachment.name}
                className="block overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setOpen(attachment)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachmentUrl(sessionId, attachment.id)} alt={attachment.name} loading="lazy" className="block size-16 object-cover" />
              </button>
            ) : (
              <a href={attachmentUrl(sessionId, attachment.id)} download={attachment.name} target="_blank" rel="noreferrer" title={attachment.name} className={`${CHIP} hover:text-foreground`}>
                <PaperclipIcon className="size-3 shrink-0" />
                <span className="max-w-48 truncate">{attachment.name}</span>
              </a>
            )}
          </li>
        ))}
      </ul>
      {sessionId && (
        <ImageLightbox sessionId={sessionId} {...(open ? { attachmentId: open.id, alt: open.name } : {})} onClose={() => setOpen(undefined)} />
      )}
    </>
  );
}
