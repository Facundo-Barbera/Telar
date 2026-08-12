"use client";
// FINAL — the gate room, merged from proposals A + B (session verdict:
// "a mixture of both, leaning B"). The DAG lives in the middle as a
// pan/zoom map (scroll zooms, grab pans, text never truncates). Clicking a
// node opens the conversation in a LEFT pane that takes MOST of the width —
// proportions inverted, the graph shrinks to a minimap gliding to the node
// you're in. The gate itself is a node: its conversation is the steering
// chat (quick chips fire real edits) and its verdict controls ride the pane.
// Agents leave a node only through the approval-gated advance_node tool.
import { useState } from "react";
import {
  CircleCheckIcon,
  Loader2Icon,
  LockIcon,
  LockOpenIcon,
  PlusIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import {
  GATE,
  LOOM,
  NODES,
  PLAN,
  PLAN_WOKEN,
  PRD_DRAFTING_CHATS,
  type ConvoTurn,
  type NodeChat,
  type PlanPreview,
  type PrepGraphNode,
} from "./fixtures";
import { GateControls, GateGraph, GateSummary, type GateVerdict } from "./shared";

type PrdStage = "dormant" | "drafting" | "done";

const GATE_OPENING: ConvoTurn[] = [
  {
    who: "intake",
    text: "Preparation converged. Drift report: 3 findings in the orders search norms; scope pinned to orders only. The plan is drafted — 11 subgoals across 4 threads. The map is live: enter any node, tell me what to change, or judge it as it stands.",
  },
];

type ChipAction = {
  label: string;
  you: string;
  agent: string;
  effect?: "wake" | "drop";
};

const CHIPS: ChipAction[] = [
  {
    label: "Wake the PRD delta",
    you: "Wake the PRD delta — I want the PRD checked against this.",
    agent:
      "Woken. Its sessions are drafting — premise sweep, then the draft. It will ask your approval to advance; watch the node on the map.",
    effect: "wake",
  },
  {
    label: "Drop e2e-search-path",
    you: "Drop the e2e-search-path thread.",
    agent:
      "Dropped. Loom-level surface verification still walks that path at the lab, so the contract keeps its coverage — the thread was belt-and-suspenders.",
    effect: "drop",
  },
  {
    label: "Why is R7 dropped?",
    you: "Why is R7 dropped from the contract?",
    agent:
      "R7 asserts typo tolerance, and there's no golden dataset to prove it against — I won't claim what I can't prove. Provide a dataset before the gate and it re-enters; otherwise it stays out rather than passing on vibes.",
  },
];

function Turns({ turns }: { turns: ConvoTurn[] }) {
  return (
    <>
      {turns.map((t) => (
        <div key={t.text} className="space-y-1">
          <span
            className={cn(
              "font-mono text-[9px] uppercase tracking-wider",
              t.who === "you" ? "text-foreground/60" : "text-muted-foreground/50",
            )}
          >
            {t.who}
          </span>
          <p className="text-sm leading-relaxed text-foreground/90">{t.text}</p>
        </div>
      ))}
    </>
  );
}

function PaneComposer({ hint, note }: { hint: string; note: string }) {
  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <InputGroup>
        <InputGroupTextarea placeholder={hint} className="field-sizing-content max-h-40 min-h-10" />
        <InputGroupAddon align="block-end" className="justify-between gap-1">
          <span className="font-mono text-[10px] text-muted-foreground/50">{note}</span>
          <InputGroupButton size="icon-sm" variant="default" aria-label="Send">
            <SendIcon className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function chatDot(open: boolean) {
  return open ? (
    <Loader2Icon className="size-3 shrink-0 animate-spin text-foreground" />
  ) : (
    <CircleCheckIcon className="size-3 shrink-0 text-muted-foreground/50" />
  );
}

export function PrepGateDemo() {
  const [sel, setSel] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<GateVerdict>("open");
  const [modify, setModify] = useState(false);
  const [prdStage, setPrdStage] = useState<PrdStage>("dormant");
  const [recompiling, setRecompiling] = useState(false);
  const [edits, setEdits] = useState<string[]>([]);
  const [activeChat, setActiveChat] = useState<string>("");
  const [extraChats, setExtraChats] = useState<Record<string, NodeChat[]>>({});
  const [gateTurns, setGateTurns] = useState<ConvoTurn[]>(GATE_OPENING);
  const [usedChips, setUsedChips] = useState<string[]>([]);
  const [dropped, setDropped] = useState(false);

  const woken = prdStage === "done";
  const base = woken ? PLAN_WOKEN : PLAN;
  const plan: PlanPreview = dropped
    ? {
        ...base,
        threads: base.threads.filter((t) => t !== "e2e-search-path"),
        line: woken ? "12 subgoals · 4 threads · 2 lanes" : "10 subgoals · 3 threads · 2 lanes",
      }
    : base;

  const chatsFor = (n: PrepGraphNode): NodeChat[] => {
    const b = n.id === "prd" && prdStage !== "dormant" ? PRD_DRAFTING_CHATS : n.chats;
    return [...b, ...(extraChats[n.id] ?? [])];
  };

  const openNode = (id: string) => {
    setSel(id);
    if (id !== "gate") {
      const n = NODES.find((x) => x.id === id);
      if (n) {
        const chats = chatsFor(n);
        const open = chats.find((c) => c.state === "open");
        setActiveChat((open ?? chats[chats.length - 1]).id);
      }
    }
  };

  const addChat = (id: string) => {
    const next: NodeChat = {
      id: `extra-${id}-${(extraChats[id]?.length ?? 0) + 1}`,
      title: "new conversation",
      when: "now",
      state: "open",
      turns: [
        {
          who: "node",
          text: "Reopened. Ask, adjust, or push this further — advancing anything still needs your approval.",
        },
      ],
    };
    setExtraChats((cur) => ({ ...cur, [id]: [...(cur[id] ?? []), next] }));
    setActiveChat(next.id);
  };

  const wake = (via: "chip" | "node") => {
    setPrdStage("drafting");
    setEdits((e) => [
      ...e,
      `you woke the PRD delta (09:37${via === "chip" ? " · from the gate chat" : ""}) — its sessions are drafting`,
    ]);
    if (via === "node") setActiveChat("prd-2");
  };

  const advance = () => {
    setPrdStage("done");
    setRecompiling(true);
    setEdits((e) => [
      ...e,
      "you approved advance_node on the PRD delta (09:41) — flow recompiled, 1 of 2 audited",
    ]);
    setTimeout(() => setRecompiling(false), 1400);
  };

  const fireChip = (chip: ChipAction) => {
    setUsedChips((u) => [...u, chip.label]);
    setGateTurns((t) => [
      ...t,
      { who: "you", text: chip.you },
      { who: "intake", text: chip.agent },
    ]);
    if (chip.effect === "wake") wake("chip");
    if (chip.effect === "drop") setDropped(true);
  };

  const chips = CHIPS.filter(
    (c) => !usedChips.includes(c.label) && !(c.effect === "wake" && prdStage !== "dormant"),
  );

  const selNode = sel && sel !== "gate" ? NODES.find((n) => n.id === sel) ?? null : null;

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {LOOM.project}
        </span>
        <h1 className="truncate text-sm font-semibold">{LOOM.title}</h1>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          <LockIcon className="size-3 text-amber-600 dark:text-amber-400" />
          gate open — nothing spent yet
        </span>
        <span className="ml-auto hidden truncate font-mono text-[10px] text-muted-foreground/60 sm:block">
          {LOOM.meta}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {sel === "gate" && (
          <aside className="flex min-w-0 flex-[1.6] flex-col border-r border-border">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <LockOpenIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-medium">Readiness gate</span>
              <span className="rounded border border-border/60 px-1 py-0.5 font-mono text-[8px] text-muted-foreground/50">
                session
              </span>
              <button
                type="button"
                onClick={() => setSel(null)}
                aria-label="close"
                className="ml-auto rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <Turns turns={gateTurns} />
              {verdict === "open" && chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      onClick={() => fireChip(c)}
                      className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2.5 border-t border-border px-4 py-3">
              {verdict === "open" && <GateSummary plan={plan} />}
              {woken && verdict === "open" && (
                <p className="font-mono text-[9px] text-muted-foreground/60">
                  {GATE.recompileLine}
                </p>
              )}
              <GateControls
                compact
                verdict={verdict}
                onVerdict={setVerdict}
                modify={modify}
                onModify={() => setModify((m) => !m)}
              />
            </div>
          </aside>
        )}

        {selNode && (
          <aside className="flex min-w-0 flex-[1.6] flex-col border-r border-border">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              {selNode.id === "prd" && prdStage === "drafting" ? (
                <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground" />
              ) : (selNode.id === "prd" ? prdStage === "done" : selNode.state === "done") ? (
                <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
              )}
              <span className="text-sm font-medium">{selNode.title}</span>
              <span className="rounded border border-border/60 px-1 py-0.5 font-mono text-[8px] text-muted-foreground/50">
                session
              </span>
              <span className="ml-auto hidden truncate font-mono text-[10px] text-muted-foreground/60 md:block">
                {selNode.id === "prd" && prdStage !== "dormant"
                  ? "PRD pass forced by you"
                  : selNode.detail}
              </span>
              <button
                type="button"
                onClick={() => setSel(null)}
                aria-label="close"
                className="rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1">
              <div className="flex w-44 shrink-0 flex-col border-r border-border">
                <p className="border-b border-border px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                  conversations · {chatsFor(selNode).length}
                </p>
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                  {chatsFor(selNode).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setActiveChat(c.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        c.id === activeChat ? "bg-muted" : "hover:bg-muted/50",
                      )}
                    >
                      {chatDot(c.state === "open" && !(selNode.id === "prd" && prdStage === "done"))}
                      <span className="min-w-0 flex-1 truncate text-xs">{c.title}</span>
                      <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50">
                        {c.when}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => addChat(selNode.id)}
                  className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <PlusIcon className="size-3.5" />
                  new chat
                </button>
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="space-y-4 px-5 py-5">
                    <Turns
                      turns={
                        (chatsFor(selNode).find((c) => c.id === activeChat) ??
                          chatsFor(selNode)[0])
                          .turns
                      }
                    />

                    {selNode.id === "prd" && prdStage === "dormant" && (
                      <div className="space-y-2">
                        {modify ? (
                          <Button type="button" size="sm" onClick={() => wake("node")}>
                            Wake this node
                          </Button>
                        ) : (
                          <p className="font-mono text-[10px] text-muted-foreground/50">
                            enter ‘Modify on the go’ at the gate to wake this node
                          </p>
                        )}
                      </div>
                    )}

                    {selNode.id === "prd" &&
                      prdStage === "drafting" &&
                      activeChat === "prd-2" && (
                        <div className="space-y-2 rounded-xl border border-foreground/25 bg-muted/20 p-3">
                          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                            tool call — awaiting your approval
                          </p>
                          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                            {PRD_DRAFTING_CHATS[1].proposal}
                          </p>
                          <div className="flex items-center gap-2">
                            <Button type="button" size="sm" onClick={advance}>
                              Approve — advance
                            </Button>
                            <Button type="button" size="sm" variant="outline">
                              Hold — keep talking
                            </Button>
                          </div>
                        </div>
                      )}

                    {selNode.id === "prd" && prdStage === "done" && activeChat === "prd-2" && (
                      <div className="flex items-start gap-2">
                        <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                          advanced with your approval 09:41 · edge grown into the flow compile ·
                          prd-alignment thread queued
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <PaneComposer
                  hint={`Message ${selNode.title}…`}
                  note="advancing needs your approval — talking is free"
                />
              </div>
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <GateGraph
              woken={woken}
              prdDrafting={prdStage === "drafting"}
              recompiling={recompiling}
              selected={sel}
              freshId={woken && !recompiling ? "prd" : null}
              onNode={openNode}
              focusId={sel}
              gateSub={
                verdict === "accepted"
                  ? "accepted → orchestrator"
                  : verdict === "denied"
                    ? "denied — loom stands down"
                    : "Accept / Modify / Deny"
              }
            />
          </div>

          {!sel && (
            <div className="flex flex-wrap items-start gap-x-8 gap-y-1 border-t border-border px-4 py-2.5">
              <div className="space-y-0.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                  plan preview — what Accept hands over
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {plan.line} · threads: {plan.threads.join(" · ")}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">{plan.contract}</p>
              </div>
              <div className="space-y-0.5">
                <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                  your edits
                </p>
                {edits.length === 0 ? (
                  <p className="font-mono text-[10px] text-muted-foreground/50">none yet</p>
                ) : (
                  edits.map((e) => (
                    <p key={e} className="font-mono text-[10px] text-muted-foreground">
                      {e}
                    </p>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
