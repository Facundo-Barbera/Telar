"use client";

import { useEffect, useRef, useState } from "react";
import type { CriticVerdict, Evidence } from "@telar/core";
import type {
  GodStatusKind,
  Operator,
  RosterEntry,
  Step,
  TranscriptEntry,
} from "./godview";
import { MessageResponse } from "@/components/ai-elements/message";
import { ToolStepRow } from "@/components/session/tool-step";
import { cn } from "@/lib/utils";
import { shortId } from "@/lib/format";

// The agent-view drawer — a right-side slide-in over a scrim, opened by clicking
// an operator in the weave. Ported from the locked mockup
// (scratchpad/loom-godview-integrated.html): Overview + Transcript tabs.
//
// OVERVIEW foregrounds the VERIFY critic panel (the acceptance evidence). The
// TRANSCRIPT tab is a picker across the operator + its fanned-out sub-agents +
// its critics, rendered from the derived roster. Where a roster entry's
// transcript is NOT available in today's data, it says so plainly rather than
// fabricating a stream.
//
// The drawer element stays mounted (so the slide transition plays); `open`
// toggles the `.open` class. It caches the last operator so content stays
// visible during the slide-out after `operator` goes null.

const PILL_GLYPH: Record<GodStatusKind, string> = {
  run: "◐",
  repair: "↺",
  verify: "▶",
  done: "✓",
  block: "✋",
  wait: "◷",
};

// ---------------------------------------------------------------------------
// Overview helpers.
// ---------------------------------------------------------------------------

type NowLine = { text: string; spinning: boolean; repair: boolean };

function nowLine(op: Operator): NowLine {
  switch (op.status.kind) {
    case "done":
      return { text: "Done — verified against its story and promoted.", spinning: false, repair: false };
    case "block":
      return {
        text: "Paused on a decision the orchestrator won't guess. The rest of the weave keeps running around it.",
        spinning: false,
        repair: false,
      };
    case "repair":
      return {
        text: "Builder resumed with the failing criterion + a repro. Reworking against the contract.",
        spinning: true,
        repair: true,
      };
    case "verify":
      return op.state === "ready"
        ? { text: "Verified by an independent panel — awaiting your acceptance.", spinning: false, repair: false }
        : { text: "Verifying — the critic panel is driving the live product.", spinning: true, repair: false };
    case "run": {
      const live = op.subAgents.filter((s) => !s.done).length;
      return {
        text: live > 0
          ? `${live} builder${live === 1 ? "" : "s"} weaving in parallel — isolated worktrees, merged on green.`
          : "Building against the spec.",
        spinning: true,
        repair: false,
      };
    }
    default:
      return { text: "Scheduled — not started yet.", spinning: false, repair: false };
  }
}

function MiniStage({ step, fanCount }: { step: Step; fanCount: number }) {
  const cls = ["st"];
  let suffix = "";
  if (step.state === "done") cls.push("done");
  else if (step.state === "failed") {
    cls.push("failed");
    suffix = " ✗";
  } else if (step.state === "active") cls.push("act");
  const label =
    step.name === "Build" && step.state === "active" && fanCount > 0
      ? `Build ×${fanCount}`
      : step.name;
  return (
    <div className={cls.join(" ")}>
      {label}
      {suffix}
    </div>
  );
}

// The drawer's mini step-list — the same DERIVED steps as the weave card, just
// smaller. Nothing when the operator hasn't taken a step yet.
function MiniPipe({ steps, fanCount }: { steps: Step[]; fanCount: number }) {
  if (steps.length === 0) return null;
  return (
    <div className="mini-pipe">
      {steps.map((s, i) => (
        <MiniStage key={`${s.name}-${i}`} step={s} fanCount={fanCount} />
      ))}
    </div>
  );
}

function evidenceCount(critic: CriticVerdict): number {
  const all: Evidence[] = [...(critic.evidence ?? []), ...critic.findings.flatMap((f) => f.evidence ?? [])];
  return all.length;
}

function CriticCard({
  critic,
  index,
  onGoto,
}: {
  critic: CriticVerdict;
  index: number;
  onGoto: (key: string) => void;
}) {
  const evN = evidenceCount(critic);
  const key = `critic-${index}`;
  return (
    <div
      className={cn("critic clickable", critic.ok ? "ok" : "fail")}
      role="button"
      tabIndex={0}
      onClick={() => onGoto(key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onGoto(key);
        }
      }}
    >
      <div className="cr-top">
        <span className="cr-ico">{critic.ok ? "✓" : "✗"}</span>
        <span className="cr-lens">{critic.lens}</span>
        <span className={cn("cr-block", critic.blocker ? "blk" : "soft")}>
          {critic.blocker ? "blocker" : "soft"}
        </span>
      </div>
      <div className="cr-sum">{critic.summary}</div>
      {critic.findings.map((f, i) => (
        <div key={i} className={cn("cr-find", critic.ok && "soft")}>
          <span className="fl">{f.severity}</span> · {f.title}
          {f.detail ? ` — ${f.detail}` : ""}
        </div>
      ))}
      {evN > 0 && (
        <div className="cr-ev">
          <span className={cn("thumb", !critic.ok && "fail")} />
          <span className="thumb" />
          <span className="evlabel">
            {evN} evidence artifact{evN === 1 ? "" : "s"}
          </span>
        </div>
      )}
      <div className="cr-tlink">
        <span className="tlink">view Playwright transcript ↳</span>
      </div>
    </div>
  );
}

function VerifyPanel({ op, onGoto }: { op: Operator; onGoto: (key: string) => void }) {
  const verifyActive = op.steps.some((s) => s.name === "Verify" && s.state === "active");
  const notBuilt = !op.steps.some((s) => s.name === "Build");
  if (op.critics.length === 0) {
    if (verifyActive) {
      return (
        <>
          <div className="kh">Verify · the critic panel</div>
          <div className="pend">◷ Verify is running — the critic panel is driving the live product.</div>
        </>
      );
    }
    if (notBuilt) {
      return (
        <>
          <div className="kh">Verify · the critic panel</div>
          <div className="pend">◷ Verify runs once this operator builds green. The panel will drive the live product.</div>
        </>
      );
    }
    return null;
  }

  return (
    <>
      <div className="kh">
        Verify · the critic panel <span style={{ color: "var(--verify)" }}>— drives the live product</span>
      </div>
      {op.url && <div className="panel-url">▶ Playwright drove {op.url}</div>}
      {op.critics.map((c, i) => (
        <CriticCard key={i} critic={c} index={i} onGoto={onGoto} />
      ))}
    </>
  );
}

function Overview({ op, onGoto }: { op: Operator; onGoto: (key: string) => void }) {
  const now = nowLine(op);
  const kind = op.status.kind;

  return (
    <>
      {op.steps.length > 0 && (
        <>
          <div className="kh">Steps so far</div>
          <MiniPipe steps={op.steps} fanCount={op.subAgents.length} />
        </>
      )}
      {op.repairs > 0 && (
        <div className="repair-arc">↺ verify ✗ → build · repair loop (bounded), attempt {op.repairs + 1}</div>
      )}

      <div className="av-now" style={{ marginTop: 14 }}>
        {now.spinning && <span className="sp" />}
        <span>{now.text}</span>
      </div>

      {op.subAgents.length > 0 && (
        <>
          <div className="kh">
            Fanned-out agents · {op.subAgents.length} <span className="tlink">— click for a transcript</span>
          </div>
          {op.subAgents.map((s) => (
            <div
              key={s.id}
              className={cn("subagent clickable", s.done && "ok")}
              role="button"
              tabIndex={0}
              onClick={() => onGoto(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onGoto(s.id);
                }
              }}
            >
              <span className="rail3" />
              <div className="sa-b">
                <div className="sa-top">
                  <span className="nm">{s.name}</span>
                  <span className="wt">{s.done ? "merged" : "live"}</span>
                </div>
                <div className="sa-now">{s.now}</div>
              </div>
            </div>
          ))}
        </>
      )}

      {kind === "block" && (
        <>
          <div className="kh">Waiting on you</div>
          <div
            className="cr-find soft"
            style={{
              background: "color-mix(in srgb,var(--accent) 8%,transparent)",
              borderColor: "var(--accent-line)",
              color: "var(--ink-dim)",
            }}
          >
            The orchestrator parked this thread on a decision it won&apos;t guess. Answer it to resume — the rest of the
            weave kept running.
          </div>
          <div className="actrow">
            <button className="btn accent sm" disabled title="Steering — coming soon">
              Answer &amp; resume
            </button>
            <button className="btn ghost sm" disabled title="Coming soon">
              Take over in chat →
            </button>
          </div>
        </>
      )}

      {op.files.length > 0 && (
        <>
          <div className="kh">Files touched</div>
          <div className="files">
            {op.files.map((f, i) => (
              <div key={`${f.path}-${i}`} className="frow">
                <span className={cn("op", f.op)}>{f.op === "add" ? "+" : "~"}</span>
                <span className="fp">{f.path}</span>
                {f.stat && <span className="st">{f.stat}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      <VerifyPanel op={op} onGoto={onGoto} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Transcript tab.
// ---------------------------------------------------------------------------

function ScriptEntry({
  e,
  open,
  onToggle,
}: {
  e: TranscriptEntry;
  open: boolean;
  onToggle: () => void;
}) {
  switch (e.k) {
    case "say":
      // Assistant prose through the same markdown renderer the session chat
      // uses — readable, not a mono blob.
      return (
        <div className="xsay">
          <MessageResponse>{e.text}</MessageResponse>
        </div>
      );
    case "tool":
      // The shared session-style collapsible tool row: name + salient preview,
      // click to expand the full input (and result, when the core captured
      // one). Degrades to a bare name-only row on old events with no input.
      return (
        <ToolStepRow
          part={{
            type: "tool",
            name: e.name,
            input: e.input,
            output: e.output,
            isError: e.isError,
          }}
          running={false}
          open={open}
          onToggle={onToggle}
        />
      );
    case "pw":
      return (
        <div>
          <span className="xtool pw">▶ {e.text}</span>
        </div>
      );
    case "res":
      return <div className={cn("xres", e.ok ? "ok" : "fail")}>{e.ok ? "✓ " : "◐ "}{e.text}</div>;
    case "note":
      return <div className="xnote">↺ {e.text}</div>;
    case "verdict":
      return (
        <div className={cn("xverdict", e.ok ? "ok" : "fail")}>
          <b style={{ color: e.ok ? "var(--ok)" : "var(--fail)" }}>{e.ok ? "PASS ✓" : "FAIL ✗"}</b>
          {e.text ? ` — ${e.text}` : ""}
        </div>
      );
    case "meta":
      return <div className="xmeta">{e.text}</div>;
    default:
      return null;
  }
}

function Transcript({
  op,
  selected,
  onSelect,
}: {
  op: Operator;
  selected: string;
  onSelect: (key: string) => void;
}) {
  if (op.roster.length === 0) {
    return <div className="pend">◷ This operator hasn&apos;t started — no transcript yet.</div>;
  }
  const active = op.roster.find((r) => r.key === selected) ?? op.roster[0];

  return (
    <>
      <div className="xsel">
        {op.roster.map((r) => (
          <span
            key={r.key}
            className={cn("xchip", r.role === "critic" && "critic", r.key === active.key && "on")}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(r.key)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onSelect(r.key);
              }
            }}
          >
            {r.label}
          </span>
        ))}
      </div>
      <div className="xmeta">
        {active.role === "critic"
          ? "read-only critic · different account · no Write/Edit/Bash"
          : "builder · Write · Edit · Bash · resumable session"}
      </div>
      {/* key on the roster entry so per-row expand state resets when the
          picker switches to a different agent's transcript. */}
      <TranscriptBody key={active.key} entry={active} />
    </>
  );
}

function TranscriptBody({ entry }: { entry: RosterEntry }) {
  // Per-row expand state, keyed by entry index — lifted here (not inside
  // ToolStepRow) since the row is a controlled component; reset on remount
  // when the picker switches (see the key above).
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({});
  if (!entry.transcript.available) {
    return (
      <div className="pend" style={{ marginTop: 12 }}>
        ◷ Transcript not captured yet — {entry.transcript.reason}
      </div>
    );
  }
  if (entry.transcript.entries.length === 0) {
    return (
      <div className="pend" style={{ marginTop: 12 }}>
        ◷ No steps recorded on this session yet.
      </div>
    );
  }
  return (
    <div className="xscript">
      {entry.transcript.entries.map((e, i) => (
        <ScriptEntry
          key={i}
          e={e}
          open={!!openRows[i]}
          onToggle={() => setOpenRows((o) => ({ ...o, [i]: !o[i] }))}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The drawer.
// ---------------------------------------------------------------------------

export function AgentViewDrawer({
  operator,
  onClose,
}: {
  operator: Operator | null;
  onClose: () => void;
}) {
  const open = operator !== null;
  const [tab, setTab] = useState<"overview" | "transcript">("overview");
  const [agentKey, setAgentKey] = useState("op");

  // Cache the last non-null operator so content stays put during the slide-out.
  const cacheRef = useRef<Operator | null>(operator);
  if (operator) cacheRef.current = operator;
  const op = operator ?? cacheRef.current;

  // Reset tab/selection whenever a different operator opens.
  const openedId = operator?.id;
  useEffect(() => {
    if (openedId) {
      setTab("overview");
      setAgentKey("op");
    }
  }, [openedId]);

  // Esc to close, only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const goto = (key: string) => {
    setAgentKey(key);
    setTab("transcript");
  };

  return (
    <div className="godview">
      <div className={cn("scrim", open && "open")} onClick={onClose} />
      <aside className={cn("drawer", open && "open")} aria-label="Agent view" aria-hidden={!open}>
        {op && (
          <>
            <div className="dh">
              <div className="av-title">
                <span className="nm">{op.name}</span>
                <span className="mid">
                  operator {shortId(op.id)} ·{" "}
                  {op.subAgents.length > 0 ? `fan-out ×${op.subAgents.length}` : "atomic"}
                </span>
              </div>
              <span className={cn("pill", op.status.kind)} style={{ marginLeft: "auto" }}>
                {PILL_GLYPH[op.status.kind]} {op.status.label}
              </span>
              <button className="x" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="db">
              <div className="av-tabs">
                <button className={cn("tab", tab === "overview" && "on")} onClick={() => setTab("overview")}>
                  Overview
                </button>
                <button className={cn("tab", tab === "transcript" && "on")} onClick={() => setTab("transcript")}>
                  Transcript
                </button>
              </div>
              {tab === "overview" ? (
                <Overview op={op} onGoto={goto} />
              ) : (
                <Transcript op={op} selected={agentKey} onSelect={setAgentKey} />
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
