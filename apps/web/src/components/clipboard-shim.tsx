"use client";

import { useEffect } from "react";
import { installClipboardShim } from "@/lib/clipboard";

/** Mounted once in the root layout — see lib/clipboard.ts for why. */
export function ClipboardShim(): null {
  useEffect(() => {
    installClipboardShim();
  }, []);
  return null;
}
