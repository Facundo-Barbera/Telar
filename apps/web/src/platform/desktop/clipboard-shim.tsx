"use client";

import { useEffect } from "react";
import { installClipboardShim } from "@/platform/desktop/clipboard";

export function ClipboardShim(): null {
  useEffect(() => {
    installClipboardShim();
  }, []);
  return null;
}
