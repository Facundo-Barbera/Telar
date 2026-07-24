"use client";
// LANE: birth (UX brainstorm 2026-07-23) — FROM SESSION TO LOOM, corrected
// twice by doctrine. The session's ENTIRE role in a loom's birth: carry the
// original premise, maybe some context — that's it. The loom detaches; its
// preparation graph is part of the LOOM and never appears in the session's
// UI (each graph section runs its own conversation, on the loom's own
// surfaces — see UX 4). Below the simple-task boundary, work stays a
// session: no loom, no graph. Real sessions UI, chrome stripped.
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  ChoiceRow,
  Composer,
  DoneLine,
  LiveIndicator,
  Marker,
  MonoLine,
  Thumb,
  TurnAgent,
  TurnYou,
  useReveal,
} from "./chat";

const REVEAL = [500, 1300] as const;

type BirthCaseSpec = {
  key: string;
  tab: string;
  project: string;
  ask: string;
  agentIntro: string;
  loomFirst: boolean; // which choice is primary — the simple-task boundary
  hereWarn?: string; // pushback when "do it here" fights the ask's size
  hereDone?: { text: string; thumb: string; receipt: string };
  loomId: string;
  handoff: string; // what the session hands over — premise + context, no more
};

const CASES: BirthCaseSpec[] = [
  {
    key: "rename",
    tab: "rename a button",
    project: "bixku",
    ask: "Rename the ‘Export’ button on the orders toolbar to ‘Download CSV’.",
    agentIntro:
      "I can do this right here — one file, label and test. Or spin it off as a loom, if you want it prepared, verified and landed on its own.",
    loomFirst: false,
    hereDone: {
      text: "Done — label and test renamed, checks green.",
      thumb: "orders-toolbar.png · just now",
      receipt: "done in this session — no loom, no graph · sessions are for exactly this",
    },
    loomId: "loom/rename-export",
    handoff: "premise: rename Export → Download CSV on the orders toolbar · context: 1 file, label + test",
  },
  {
    key: "search",
    tab: "search filters",
    project: "novarix",
    ask: "Our orders search is a mess — I want proper filters over everything: status, customer, totals, dates. And it should feel fast.",
    agentIntro:
      "This spans schema, query, UI and verification — loom work. I’ll spin it off with your premise and what this chat knows about orders search. It takes it from there.",
    loomFirst: true,
    hereWarn:
      "I can, but a session gives you no preparation, no contract, and no parallel threads — this one deserves the loom. My advice stands.",
    loomId: "loom/search-filters",
    handoff:
      "premise: proper filters over orders (status, customer, totals, dates), fast · context: current search is prefix-only, 3 views ship ad-hoc filters",
  },
];

function BirthCase({ spec }: { spec: BirthCaseSpec }) {
  const step = useReveal(REVEAL);
  const [born, setBorn] = useState(false);
  const [warned, setWarned] = useState(false);
  const [hereStage, setHereStage] = useState<"idle" | "running" | "done">("idle");

  const doHere = () => {
    if (spec.hereDone) {
      setHereStage("running");
      setTimeout(() => setHereStage("done"), 3200);
    } else {
      setWarned(true);
    }
  };

  const choices = [
    { label: "Spin off the loom", kind: spec.loomFirst ? ("primary" as const) : undefined },
    { label: "Do it here", kind: spec.loomFirst ? undefined : ("primary" as const) },
  ];

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
          <TurnYou>{spec.ask}</TurnYou>

          {step === 1 && <LiveIndicator kind="thinking" />}

          {step >= 2 && (
            <>
              <TurnAgent>
                <p>{spec.agentIntro}</p>
              </TurnAgent>

              {warned && !born && (
                <TurnAgent>
                  <p>{spec.hereWarn}</p>
                </TurnAgent>
              )}

              {!born && hereStage === "idle" && (
                <ChoiceRow
                  choices={choices}
                  onPick={(l) => (l === "Spin off the loom" ? setBorn(true) : doHere())}
                />
              )}

              {hereStage === "running" && (
                <LiveIndicator
                  kind="tool"
                  tool="Edit"
                  target="orders/toolbar.tsx · label + test"
                />
              )}
              {hereStage === "done" && spec.hereDone && (
                <>
                  <TurnAgent>
                    <p>{spec.hereDone.text}</p>
                    <div className="flex items-start gap-3">
                      <Thumb label={spec.hereDone.thumb} />
                      <MonoLine>+6 −6 · checks green</MonoLine>
                    </div>
                  </TurnAgent>
                  <DoneLine>{spec.hereDone.receipt}</DoneLine>
                </>
              )}

              {born && (
                <>
                  <Marker>
                    loom created — {spec.loomId} · detached from this session
                  </Marker>
                  <TurnAgent>
                    <p>
                      Loom created. It has your premise and this chat’s context — the rest of
                      its preparation is its own conversations, on its own pages. This session
                      stays a session.
                    </p>
                    <MonoLine>{spec.handoff}</MonoLine>
                  </TurnAgent>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <Composer
        hint={`Ask about ${spec.project}…`}
        note="sessions do the small work · looms detach for the big"
      />
    </>
  );
}

export function LoomBirthDemo() {
  const [caseKey, setCaseKey] = useState(CASES[0].key);
  const active = CASES.find((c) => c.key === caseKey) ?? CASES[0];

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-b border-border px-4 pt-3">
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="text-sm font-semibold">From session to loom</h1>
          <div className="mt-2 flex items-center gap-4">
            {CASES.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCaseKey(c.key)}
                className={cn(
                  "flex items-baseline gap-2 border-b-2 px-1 pb-2.5 text-sm transition-colors",
                  caseKey === c.key
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground/80",
                )}
              >
                {c.tab}
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {c.project}
                </span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <BirthCase key={active.key} spec={active} />
    </div>
  );
}
