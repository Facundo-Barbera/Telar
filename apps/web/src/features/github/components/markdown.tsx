"use client";

import type { ComponentProps } from "react";
import { MessageResponse } from "@/ui/message";

export const READING_MEASURE = "max-w-[64ch]";

const PANEL_MARKDOWN =
  "text-xs [&_h1]:text-sm [&_h1]:mt-3 [&_h2]:text-xs-plus [&_h2]:mt-3 [&_h3]:text-xs [&_h4]:text-xs [&_h5]:text-xs [&_h6]:text-xs [&_pre]:text-3xs [&_code]:text-3xs";

// Streamdown renders links as buttons and images with a download button, so a linked
// image nests a button in a button (a hydration error). A plain image keeps the link gate.
const PANEL_IMAGE = {
  img: ({ src, alt, title }: ComponentProps<"img">) =>
    typeof src === "string" && src ? (
      /* eslint-disable-next-line @next/next/no-img-element -- arbitrary remote hosts from issue bodies */
      <img
        src={src}
        alt={alt ?? ""}
        {...(title ? { title } : {})}
        loading="lazy"
        className="my-1 max-h-64 max-w-full rounded border border-border"
      />
    ) : null,
};

/** GitHub markdown through the transcript's renderer, rescaled for the panel. */
export function Markdown({ children }: { children: string }) {
  return (
    <MessageResponse className={PANEL_MARKDOWN} components={PANEL_IMAGE}>
      {children}
    </MessageResponse>
  );
}
