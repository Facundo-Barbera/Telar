"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { claimChords } from "@/features/commands";
import {
  cloneRequest,
  matchTargets,
  paletteBack,
  pathRequest,
  QUICK_PICK_LIMIT,
  sourceRows,
  type NewConversationTarget,
  type PalettePage,
  type ProjectSource,
  type Registered,
} from "../palette-model";
import { useProjectAdding } from "./use-project-adding";

export type ProjectPalettePage = PalettePage | "local" | "clone-url" | "clone-parent";

const QUICK_PICK_CHORDS = Array.from({ length: QUICK_PICK_LIMIT }, (_, index) => `CommandOrControl+${index + 1}`);

function useQuickPickChords(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    return claimChords(QUICK_PICK_CHORDS);
  }, [active]);
}

type ListKeys = { count: number; index: number; pick: (at: number) => void; step: (delta: number) => void; back: (() => void) | undefined };

function listKey(event: React.KeyboardEvent, { count, index, pick, step, back }: ListKeys) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
    event.preventDefault();
    pick(Number(event.key) - 1);
    return;
  }
  if (event.key === "Backspace" && back) {
    event.preventDefault();
    back();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (count === 0) return;
    event.preventDefault();
    step(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    pick(index);
  }
}

export function useProjectPalette({
  open,
  openOn,
  targets,
  onClose,
  onChoose,
  onRegistered,
  onBack,
}: {
  open: boolean;
  openOn: PalettePage;
  targets: readonly NewConversationTarget[];
  onClose: () => void;
  onChoose: (target: NewConversationTarget) => void;
  onRegistered: (registered: Registered) => void;
  onBack: (() => void) | undefined;
}) {
  const [page, setPage] = useState<ProjectPalettePage>(openOn);
  const [query, setQuery] = useState("");
  const composing = useRef(false);
  const [index, setIndex] = useState(0);
  const [cloneUrl, setCloneUrl] = useState<string>();
  const [startAt, setStartAt] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const { busy, setBusy, addLocalFolder, cloneInto, pickWithSystem } = useProjectAdding({ onClose, onRegistered, setNotice });

  const matches = useMemo(() => matchTargets(targets, query), [targets, query]);
  const rows = useMemo(() => sourceRows(query), [query]);
  const count = page === "projects" ? matches.length + 1 : rows.length;

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPage(openOn);
      setQuery("");
      setIndex(0);
      setBusy(false);
      setNotice(undefined);
      setCloneUrl(undefined);
      setStartAt(undefined);
    }
  }

  useQuickPickChords(open && (page === "projects" || page === "sources"));

  const go = (next: ProjectPalettePage) => {
    setPage(next);
    setQuery("");
    setIndex(0);
    setNotice(undefined);
  };

  const backRoot: PalettePage = onBack ? openOn : "projects";
  const list: PalettePage = page === "sources" ? "sources" : "projects";
  const backsTo = paletteBack(list, "", backRoot);
  const goBack = () => {
    if (backsTo === "projects") go("projects");
    else onBack?.();
  };

  const choose = (target: NewConversationTarget | undefined) => {
    if (!target) return;
    onClose();
    onChoose(target);
  };

  const submitFolder = (root: string) => void (page === "local" ? addLocalFolder(root) : cloneUrl && cloneInto(cloneUrl, root));

  const pickSource = (source: ProjectSource | undefined) => {
    if (!source || busy) return;
    if (source.setupRequired) {
      setNotice(`${source.title} is not set up yet. Clone it yourself and add it as a local folder.`);
      return;
    }
    if (!source.clones) {
      setStartAt(pathRequest(query));
      go("local");
      return;
    }
    const clone = cloneRequest(query);
    setCloneUrl(clone?.url);
    go(clone ? "clone-parent" : "clone-url");
  };

  const takeCloneUrl = (typed: string) => {
    const clone = cloneRequest(typed);
    if (!clone) {
      setNotice("That is not a clone URL. Paste an https, ssh or git URL — or owner/repo.");
      return;
    }
    setCloneUrl(clone.url);
    go("clone-parent");
  };

  const take = (at: number) => {
    if (page === "sources") {
      pickSource(rows[at]);
      return;
    }
    if (at >= matches.length) go("sources");
    else choose(matches[at]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (page !== "projects" && page !== "sources") return;
    if (composing.current) return;
    listKey(event, {
      count,
      pick: take,
      index,
      step: (delta) => setIndex((current) => (current + delta + count) % count),
      back: paletteBack(list, query, backRoot) ? goBack : undefined,
    });
  };

  const search = (next: string) => {
    setQuery(next);
    setIndex(0);
    setNotice(undefined);
  };

  return {
    page,
    query,
    search,
    composing,
    index,
    setIndex,
    count,
    matches,
    rows,
    notice,
    setNotice,
    busy,
    startAt,
    backsTo,
    go,
    goBack,
    choose,
    submitFolder,
    pickWithSystem,
    pickSource,
    takeCloneUrl,
    onKeyDown,
  };
}
