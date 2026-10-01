"use client";

import { useState } from "react";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { createEngineApi } from "@/platform/engine";
import { formatBytes } from "@/ui/format";
import { desktopStore } from "../desktop-store";

const api = createEngineApi();

export function useStoreActions(refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  const copyStore = async () => {
    const chosen = await chooseDirectory({ title: "Choose where Telar should write the copy" });
    if (!("path" in chosen)) {
      if ("unavailable" in chosen) setFailure(chosen.unavailable);
      return;
    }
    setCopying(true);
    setFailure(undefined);
    setCopied(undefined);
    try {
      const destination = `${chosen.path.replace(/\/$/, "")}/telar-store-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const { copy } = await api.copyStore(destination);
      setCopied(`Copied ${copy.files.toLocaleString()} files (${formatBytes(copy.bytes)}) to ${copy.root}.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Telar could not write the copy.");
    } finally {
      setCopying(false);
    }
  };

  const removeOld = async () => {
    setBusy(true);
    try {
      const outcome = await desktopStore()?.removeOld();
      if (outcome && !outcome.ok) setFailure(outcome.message);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const keepOld = async () => {
    await desktopStore()?.keepOld();
    refresh();
  };

  return { busy, failure, copying, copied, copyStore, removeOld, keepOld };
}
