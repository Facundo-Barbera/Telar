"use client";
// LANE: delivery (UX brainstorm 2026-07-23) — the FINAL delivery design,
// converged from three proposals (dossier / coffee inbox / see-it-in-work).
// Assembly per session verdicts: the SHELF is the fleet accept surface
// (inbox of skimmable cards, judge in any order, in place); opening a card
// is TASTE-FIRST — the ready product on the frozen final-verify lane leads,
// then the cited narrative, contract, evidence ledger, attempt history and
// the advisory vision pre-verdict scroll below; the verdict bar rides the
// footer. One verdict state per delivery, shared between shelf and card.
import { useState } from "react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  EyeIcon,
  FlagIcon,
  FlaskConicalIcon,
  GlobeIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DELIVERIES, INBOX, type Delivery, type InboxCard } from "./fixtures";
import {
  CiteChip,
  EvidenceThumb,
  GradeBadge,
  KIND_ICON,
  ProjectTag,
  RiskChip,
  UnverifiedChip,
  VerdictBar,
  type VerdictState,
} from "./shared";

// ---- The glass: what the frozen final-verify lane is serving. A wireframe
// stand-in — the active view only swaps annotations so the flip is visible.
function Frame({ highlight }: { highlight: boolean }) {
  return (
    <div className="flex aspect-[16/9] flex-col overflow-hidden rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <div className="h-2 w-20 rounded-sm bg-muted-foreground/25" />
        <div className="ml-auto flex gap-1.5">
          <div className="h-2 w-10 rounded-sm bg-muted-foreground/15" />
          <div className="h-2 w-10 rounded-sm bg-muted-foreground/15" />
        </div>
      </div>
      <div className="flex-1 space-y-2 p-3">
        <div className="h-2 w-1/3 rounded-sm bg-muted-foreground/20" />
        {[0, 1, 2].map((r) => (
          <div key={r} className="flex items-center gap-2">
            <div className="h-2.5 flex-1 rounded-sm bg-muted-foreground/10" />
            <div className="h-2.5 w-16 rounded-sm bg-muted-foreground/15" />
          </div>
        ))}
        <div
          className={cn(
            "rounded-md border p-2",
            highlight ? "border-foreground/30" : "border-border/60",
          )}
        >
          <div className="h-2 w-1/2 rounded-sm bg-muted-foreground/20" />
          <div className="mt-1.5 h-2 w-2/3 rounded-sm bg-muted-foreground/10" />
          <div className="mt-1.5 h-3 w-24 rounded-sm bg-muted-foreground/25" />
        </div>
      </div>
    </div>
  );
}

// ---- Shelf row: the 15-second skim. Verdict lives here too — most cards
// should never need opening.
function ShelfCard({
  card,
  delivery,
  verdict,
  onVerdict,
  onOpen,
}: {
  card: InboxCard;
  delivery: Delivery;
  verdict: VerdictState;
  onVerdict: (v: VerdictState) => void;
  onOpen: () => void;
}) {
  return (
    <article className={cn("rounded-xl border border-border bg-card", verdict !== "idle" && "opacity-80")}>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full space-y-2.5 p-3.5 text-left transition-colors hover:bg-muted/20"
      >
        <div className="flex items-center gap-2">
          <ProjectTag name={card.project} />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{card.title}</h2>
          <GradeBadge />
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
        </div>
        <p className="text-xs leading-relaxed text-foreground/90">{card.claim}</p>
        <div className="flex items-start gap-3">
          {card.evidence.map((e) => (
            <EvidenceThumb key={e.label} evidence={e} />
          ))}
          <p className="pt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {card.proof}
          </p>
        </div>
        {card.risks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {card.risks.map((r) => (
              <RiskChip key={r} label={r} />
            ))}
          </div>
        )}
      </button>
      <div className="border-t border-border/60 px-3.5 py-2.5">
        <VerdictBar
          compact
          acceptLabel={delivery.acceptLabel}
          acceptedLine={delivery.acceptedLine}
          boomerangLine={delivery.boomerangLine}
          resolved={verdict}
          onResolve={onVerdict}
        />
      </div>
    </article>
  );
}

// ---- The open card: glass on top, courtroom below, verdict in the footer.
function CardBody({
  d,
  verdict,
  onVerdict,
  onBack,
}: {
  d: Delivery;
  verdict: VerdictState;
  onVerdict: (v: VerdictState) => void;
  onBack: () => void;
}) {
  const [view, setView] = useState(d.lane.views[0].id);
  const [lit, setLit] = useState<string | null>(null);
  const toggle = (id: string) => setLit((cur) => (cur === id ? null : id));
  const activeView = d.lane.views.find((v) => v.id === view) ?? d.lane.views[0];
  const contractPass = `${d.contract.length}/${d.contract.length} green`;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          deliveries
        </button>
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {d.branch}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
          <header className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <ProjectTag name={d.project} />
              <h1 className="text-sm font-semibold">{d.title}</h1>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                <FlaskConicalIcon className="size-3 text-emerald-600 dark:text-emerald-400" />
                ready to judge
              </span>
              <GradeBadge />
            </div>
            <p className="text-xs text-muted-foreground">{d.claim}</p>
            <p className="font-mono text-[10px] text-muted-foreground/60">{d.meta}</p>
          </header>

          {/* Taste first: the ready product leads. */}
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
                <GlobeIcon className="size-3 text-foreground/70" />
                {d.lane.url}
              </span>
              <span className="truncate font-mono text-[9px] text-muted-foreground/50">
                {d.lane.line}
              </span>
            </div>
            <Frame highlight={view !== "live"} />
            <div className="flex items-center gap-2">
              {d.lane.views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 font-mono text-[10px] transition-colors",
                    view === v.id
                      ? "border-foreground/40 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v.id === "live" ? "live lane" : v.label.split(" · ")[0]}
                </button>
              ))}
              <span className="ml-auto truncate font-mono text-[9px] text-muted-foreground/50">
                {activeView.label}
              </span>
            </div>
          </section>

          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
            <p className="font-mono text-[10px] text-muted-foreground">{d.manifest}</p>
          </div>

          <section className="space-y-1.5">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              What happened
            </h2>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {d.narrative.map((c, i) => (
                <div
                  key={c.text}
                  className={cn(
                    "flex items-start gap-2.5 px-3 py-2.5",
                    i > 0 && "border-t border-border/60",
                  )}
                >
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/90">
                    {c.text}
                  </p>
                  <span className="flex shrink-0 items-center gap-1 pt-0.5">
                    {c.cites.length === 0 ? (
                      <UnverifiedChip />
                    ) : (
                      c.cites.map((e) => (
                        <CiteChip key={e} id={e} active={lit === e} onClick={() => toggle(e)} />
                      ))
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-1.5">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              The contract · {contractPass}
            </h2>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {d.contract.map((a, i) => (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2",
                    i > 0 && "border-t border-border/60",
                  )}
                >
                  <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="font-mono text-[9px] text-muted-foreground/60">{a.id}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                    {a.desc}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {a.cites.map((e) => (
                      <CiteChip key={e} id={e} active={lit === e} onClick={() => toggle(e)} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-1.5">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Evidence ledger
            </h2>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {d.ledger.map((e, i) => {
                const Kind = KIND_ICON[e.kind];
                return (
                  <div
                    key={e.id}
                    className={cn(
                      "px-3 py-2.5 transition-colors",
                      i > 0 && "border-t border-border/60",
                      lit === e.id && "bg-muted/40",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <Kind className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono text-[9px] text-muted-foreground/60">{e.id}</span>
                      <span className="truncate font-mono text-xs text-foreground/90">
                        {e.label}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/50">
                        {e.provenance}
                      </span>
                    </div>
                    <div className="mt-1 flex items-start gap-2.5 pl-6">
                      <p className="min-w-0 flex-1 font-mono text-[10px] text-muted-foreground">
                        {e.note}
                      </p>
                      {e.kind === "shot" && lit === e.id && (
                        <EvidenceThumb evidence={{ label: e.label, age: "release lane" }} wide />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="space-y-1.5">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Verify attempts
            </h2>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {d.attempts.map((v, i) => (
                <div key={v.id} className={cn("px-3 py-2", i > 0 && "border-t border-border/60")}>
                  <div className="flex items-center gap-2.5">
                    {v.outcome === "green" ? (
                      <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <FlagIcon className="size-3.5 shrink-0 text-destructive" />
                    )}
                    <span className="font-mono text-[9px] text-muted-foreground/60">
                      {v.id} · {v.when}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                      {v.note}
                    </span>
                    <span className="shrink-0 rounded border border-border px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                      {v.grade}
                    </span>
                  </div>
                  {v.flaky && (
                    <p className="mt-1 flex items-center gap-1.5 pl-6 font-mono text-[10px] text-muted-foreground">
                      <FlagIcon className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
                      {v.flaky}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <EyeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs text-foreground/85">
                <span className="font-medium">vision critic</span>
                <span className="ml-2 rounded border border-border px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                  advisory · {d.vision.verdict}
                </span>
              </p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">{d.vision.note}</p>
            </div>
          </div>
        </div>
      </div>

      <footer className="border-t border-border bg-background px-6 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <VerdictBar
            acceptLabel={d.acceptLabel}
            acceptedLine={d.acceptedLine}
            boomerangLine={d.boomerangLine}
            resolved={verdict}
            onResolve={onVerdict}
          />
        </div>
      </footer>
    </div>
  );
}

export function DeliveryFinalDemo() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, VerdictState>>({});
  const setVerdict = (id: string) => (v: VerdictState) =>
    setVerdicts((cur) => ({ ...cur, [id]: v }));

  const open = openId ? DELIVERIES.find((d) => d.id === openId) : undefined;
  if (open) {
    return (
      <CardBody
        d={open}
        verdict={verdicts[open.id] ?? "idle"}
        onVerdict={setVerdict(open.id)}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-6">
          <header className="flex items-baseline gap-2">
            <h1 className="text-sm font-semibold">Deliveries</h1>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              3 ready · judge in any order
            </span>
          </header>
          <div className="space-y-3">
            {INBOX.map((card) => {
              const delivery = DELIVERIES.find((d) => d.id === card.id);
              if (!delivery) return null;
              return (
                <ShelfCard
                  key={card.id}
                  card={card}
                  delivery={delivery}
                  verdict={verdicts[card.id] ?? "idle"}
                  onVerdict={setVerdict(card.id)}
                  onOpen={() => setOpenId(card.id)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
