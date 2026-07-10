"use client";

import { useCallback, useEffect, useState } from "react";
import { FileIcon, ScrollTextIcon, TriangleAlertIcon } from "lucide-react";
import type { AssertionType, ContractAssertion, VerificationContract } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { fmtAgo, shortId } from "@/lib/format";
import { MessageResponse } from "@/components/ai-elements/message";

// The GET /api/looms/[id]/spec response shape — the bundle manifest
// (docs/loom-model.md §2): objective + files + the Verification Contract
// (or its validation errors, §M.1) + provenance (§M.6). No zod import here —
// this mirrors how WeaveGodView/CharterReview treat fetched JSON, as a plain
// shape, not a runtime-validated one.
type SpecBundleProvenance = { approvedBy: string; humanApprovedAt: number; sessionId?: string };

type SpecBundleData = {
  version: string;
  files: string[];
  objective: string | null;
  contract: VerificationContract | null;
  contractErrors: string[];
  provenance: SpecBundleProvenance | null;
};

const ASSERTION_TYPE_LABEL: Record<AssertionType, string> = {
  "golden-diff": "golden diff",
  "value-equality": "value equality",
  "schema-match": "schema match",
  contains: "contains",
  "live-critic": "live critic",
};

function AssertionRow({
  loomId,
  assertion,
}: {
  loomId: string;
  assertion: ContractAssertion;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="font-mono text-[10px]">
          {ASSERTION_TYPE_LABEL[assertion.type]}
        </Badge>
        <Badge
          className={cn(
            "font-mono text-[10px]",
            assertion.blocker
              ? "bg-destructive/15 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {assertion.blocker ? "blocker" : "advisory"}
        </Badge>
      </div>
      <p className="min-w-0 text-sm leading-snug break-words">{assertion.description}</p>
      {assertion.type === "live-critic" ? (
        assertion.observable && (
          <p className="min-w-0 break-words font-mono text-[11px] text-muted-foreground">
            observes: {assertion.observable}
          </p>
        )
      ) : assertion.expectedFile ? (
        <a
          href={`/api/looms/${loomId}/spec/${assertion.expectedFile}`}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {assertion.expectedFile}
        </a>
      ) : assertion.expected ? (
        <p className="min-w-0 break-words font-mono text-[11px] text-muted-foreground">
          {assertion.expected}
        </p>
      ) : null}
    </div>
  );
}

// §2's "you see WHAT we're building (spec) and HOW we'll know (contract)"
// surface. Self-fetches once and no-ops (returns null) for a loom that has
// no bundle at all — the page mounts this unconditionally alongside every
// other loom kind, including plain quickfix/story looms without one.
export function SpecBundle({ loomId }: { loomId: string }) {
  const [bundle, setBundle] = useState<SpecBundleData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/looms/${loomId}/spec`)
      .then((res) => (res.ok ? (res.json() as Promise<SpecBundleData>) : null))
      .then((data) => {
        if (!cancelled) setBundle(data);
      })
      .catch(() => {
        /* no bundle for this loom (or transient) — render nothing */
      });
    return () => {
      cancelled = true;
    };
  }, [loomId]);

  if (!bundle) return null;

  const files = bundle.files ?? [];
  const assertions = bundle.contract?.assertions ?? [];
  const contractErrors = bundle.contractErrors ?? [];

  if (files.length === 0 && !bundle.contract) return null;

  return (
    <Card className="border-l-2 border-l-primary/40">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <ScrollTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          Spec Bundle
        </span>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          {shortId(bundle.version)}
        </Badge>
        {bundle.provenance && (
          <span className="ml-auto min-w-0 break-words text-xs text-muted-foreground">
            approved by{" "}
            <span className="text-foreground">{bundle.provenance.approvedBy}</span> ·{" "}
            {fmtAgo(bundle.provenance.humanApprovedAt)}
          </span>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {bundle.objective && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Objective
            </h3>
            <MessageResponse className="max-w-[70ch] text-sm leading-relaxed">
              {bundle.objective}
            </MessageResponse>
          </div>
        )}

        {contractErrors.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
              <TriangleAlertIcon className="size-3.5 shrink-0" />
              Verification contract issues
            </div>
            <ul className="flex flex-col gap-0.5 pl-5 text-xs text-amber-200/90">
              {contractErrors.map((e, i) => (
                <li key={i} className="list-disc">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        )}

        {assertions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Verification contract
            </h3>
            <div className="flex flex-col gap-2">
              {assertions.map((a) => (
                <AssertionRow key={a.id} loomId={loomId} assertion={a} />
              ))}
            </div>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Files
            </h3>
            <ul className="flex flex-col gap-1">
              {files.map((f) => (
                <li key={f} className="min-w-0">
                  <a
                    href={`/api/looms/${loomId}/spec/${f}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
                  >
                    <FileIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{f}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SpecDrawer — the same bundle as a non-invasive right-side slide-in, opened by
// the god-view charter strip's "View spec". Rendered in the locked mockup's
// drawer style (scratchpad/loom-godview-integrated.html) so it never reflows or
// colonizes the main view. Self-fetches once per loom; guards a missing bundle.
// ---------------------------------------------------------------------------

function assertionDetail(a: ContractAssertion): string | null {
  if (a.type === "live-critic") return a.observable ? `observes: ${a.observable}` : null;
  if (a.expectedFile) return a.expectedFile;
  if (a.expected) return a.expected;
  return null;
}

function useSpecBundle(loomId: string, active: boolean) {
  const [bundle, setBundle] = useState<SpecBundleData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch(`/api/looms/${loomId}/spec`)
      .then((res) => (res.ok ? (res.json() as Promise<SpecBundleData>) : null))
      .then((data) => {
        if (cancelled) return;
        setBundle(data);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loomId, active]);

  return { bundle, loaded };
}

export function SpecDrawer({
  loomId,
  open,
  onClose,
}: {
  loomId: string;
  open: boolean;
  onClose: () => void;
}) {
  // Fetch on first open, keep it cached across close/reopen.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  const { bundle, loaded } = useSpecBundle(loomId, everOpened);

  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const files = bundle?.files ?? [];
  const assertions = bundle?.contract?.assertions ?? [];
  const contractErrors = bundle?.contractErrors ?? [];
  const hasBundle = !!bundle && (files.length > 0 || !!bundle.contract || !!bundle.objective);

  return (
    <div className="godview">
      <div className={cn("scrim", open && "open")} onClick={close} />
      <aside className={cn("drawer", open && "open")} aria-label="Spec bundle" aria-hidden={!open}>
        <div className="dh">
          <div className="av-title">
            <span className="nm">Spec Bundle</span>
            {bundle && <span className="mid">{shortId(bundle.version)}</span>}
          </div>
          <button className="x" onClick={close} aria-label="Close" style={{ marginLeft: "auto" }}>
            ✕
          </button>
        </div>
        <div className="db">
          {!loaded ? (
            <div className="pend">◷ Loading the spec bundle…</div>
          ) : !hasBundle ? (
            <div className="pend">◷ This loom has no spec bundle.</div>
          ) : (
            <>
              {bundle!.objective && (
                <>
                  <div className="kh">objective.md</div>
                  <MessageResponse className="spec-obj">{bundle!.objective}</MessageResponse>
                </>
              )}

              {contractErrors.length > 0 && (
                <>
                  <div className="kh">Verification contract · issues</div>
                  <div className="warnbox">
                    {contractErrors.map((e, i) => (
                      <span key={i}>⚠ {e}</span>
                    ))}
                  </div>
                </>
              )}

              {assertions.length > 0 && (
                <>
                  <div className="kh">
                    Verification contract · {assertions.length} assertion{assertions.length === 1 ? "" : "s"}
                  </div>
                  {assertions.map((a) => {
                    const detail = assertionDetail(a);
                    return (
                      <div key={a.id} className="assert">
                        <span className="ax">{a.id}</span>
                        <span className="atxt">
                          {a.description}
                          {detail && (
                            <>
                              {" "}
                              <span className="m">{detail}</span>
                            </>
                          )}
                        </span>
                        <span className={cn("blk", !a.blocker && "soft")}>
                          {a.blocker ? "blocker" : "advisory"}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}

              {files.length > 0 && (
                <>
                  <div className="kh">Context files</div>
                  <div className="filelist">
                    {files.map((f) => (
                      <a
                        key={f}
                        href={`/api/looms/${loomId}/spec/${f}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="fi">📄</span>
                        <span className="fn">{f}</span>
                      </a>
                    ))}
                  </div>
                </>
              )}

              <div className="moat" style={{ margin: "22px 0 0" }}>
                <span className="lock">🔒</span>
                <span>
                  The contract is the yardstick. Loosening an assertion under a failing verdict needs a human
                  co-sign — editing the yardstick is <b>set_verdict in disguise</b>.
                </span>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
