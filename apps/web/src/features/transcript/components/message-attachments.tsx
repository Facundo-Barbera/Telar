"use client";

import { createContext, useContext, useState } from "react";
import { PaperclipIcon } from "lucide-react";
import type { TurnAttachment } from "@telar/engine-client";
import { attachmentUrl, humanBytes, ImageLightbox } from "@/features/plugins";

/** The session whose attachment route serves the files drawn below it. */
export const TranscriptSession = createContext<string | undefined>(undefined);

const CHIP = "flex items-center gap-1.5 rounded-md bg-background/60 px-2 py-1 text-2xs text-muted-foreground";

function ChipBody({ attachment }: { attachment: TurnAttachment }) {
  return (
    <>
      <PaperclipIcon className="size-3 shrink-0" />
      <span className="max-w-48 truncate">{attachment.name}</span>
      <span className="shrink-0 tabular-nums opacity-70">{humanBytes(attachment.bytes)}</span>
    </>
  );
}

export function MessageAttachments({ attachments }: { attachments?: readonly TurnAttachment[] }) {
  const sessionId = useContext(TranscriptSession);
  const [open, setOpen] = useState<TurnAttachment>();
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  if (!attachments?.length) return null;
  const fail = (id: string) => setFailed((prior) => new Set(prior).add(id));
  const url = (attachment: TurnAttachment, display = false) =>
    attachmentUrl(sessionId!, attachment.id, { display });
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {attachments.map((attachment) => (
          <li key={attachment.id}>
            {!sessionId ? (
              <span title={attachment.path} className={CHIP}>
                <ChipBody attachment={attachment} />
              </span>
            ) : attachment.mediaType.startsWith("image/") && !failed.has(attachment.id) ? (
              <button
                type="button"
                aria-label={`Open ${attachment.name}`}
                title={attachment.name}
                className="block overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setOpen(attachment)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url(attachment, true)} alt={attachment.name} loading="lazy" onError={() => fail(attachment.id)} className="block size-16 object-cover" />
              </button>
            ) : (
              <a href={url(attachment)} download={attachment.name} target="_blank" rel="noreferrer" title={attachment.name} className={`${CHIP} hover:text-foreground`}>
                <ChipBody attachment={attachment} />
              </a>
            )}
          </li>
        ))}
      </ul>
      {sessionId && (
        <ImageLightbox
          {...(open ? { src: url(open, true), alt: open.name } : {})}
          onClose={() => setOpen(undefined)}
          onError={() => {
            if (open) fail(open.id);
            setOpen(undefined);
          }}
        />
      )}
    </>
  );
}
