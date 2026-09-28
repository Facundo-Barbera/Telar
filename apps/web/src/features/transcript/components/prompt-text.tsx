"use client";

import { Fragment } from "react";
import { CHIP_CLASS, CHIP_ICON_CLASS, CHIP_LABEL_CLASS, chipIsDirectory, chipPath, chipTitle, segmentDraft } from "@/features/composer";
import { chipGlyphFor, type TelarReference } from "@/features/composer";
import { cn } from "@/ui/utils";
import { filePanelTab, issuePanelTab, pullPanelTab, type PanelTab } from "@/features/panel";

function ChipGlyph({ markup, className }: { markup: string; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export function panelTabFor(reference: TelarReference): PanelTab | undefined {
  if (reference.kind === "issue") {
    const number = /^#(\d+) /.exec(reference.text);
    return number ? issuePanelTab(Number(number[1])) : undefined;
  }
  if (reference.kind === "pull") {
    const number = /^PR #(\d+) /.exec(reference.text);
    return number ? pullPanelTab(Number(number[1])) : undefined;
  }
  if (reference.kind === "file" && !chipIsDirectory(reference)) return filePanelTab(chipPath(reference));
  return undefined;
}

function ReferenceChip({ reference, onOpen }: { reference: TelarReference; onOpen?: (tab: PanelTab) => void }) {
  const { markup, tint } = chipGlyphFor(reference);
  const tab = onOpen ? panelTabFor(reference) : undefined;
  const body = (
    <>
      <ChipGlyph markup={markup} className={cn(CHIP_ICON_CLASS, tint)} />
      <span className={CHIP_LABEL_CLASS}>{reference.label}</span>
    </>
  );
  if (!tab) {
    return (
      <span className={CHIP_CLASS} title={chipTitle(reference)}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Open — ${chipTitle(reference)}`}
      className={cn(CHIP_CLASS, "cursor-pointer transition-colors hover:border-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}
      onClick={() => onOpen?.(tab)}
    >
      {body}
    </button>
  );
}

export function PromptText({
  text,
  className,
  onOpen,
}: {
  text: string;
  className?: string;
  onOpen?: (tab: PanelTab) => void;
}) {
  return (
    <p className={cn("whitespace-pre-wrap", className)}>
      {segmentDraft(text).map((segment, index) =>
        segment.type === "chip" ? (
          <ReferenceChip key={index} reference={segment.reference} {...(onOpen ? { onOpen } : {})} />
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </p>
  );
}
