"use client";

import { useState } from "react";
import type { TurnState } from "@telar/engine-client";
import { Icon } from "./vnext-icons";

/** A deliberately small local utility surface. It names only facts the engine exposes. */
export function VNextRightPanel({ projectId, sessionId, active }: { projectId: string; sessionId: string; active?: TurnState }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="vnext-icon-button" aria-label="Open session details" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="panel" /></button>
    {open && <aside className="vnext-right-panel" aria-label="Session details"><header><div><span className="vnext-panel-kicker">Engine session</span><strong>Details</strong></div><button className="vnext-icon-button" type="button" aria-label="Close session details" onClick={() => setOpen(false)}><Icon name="close" /></button></header><div className="vnext-right-panel__body"><dl><div><dt>Project</dt><dd>{projectId}</dd></div><div><dt>Session</dt><dd>{sessionId}</dd></div><div><dt>Turn state</dt><dd>{active ? active : "No active turn"}</dd></div></dl><p>This panel intentionally contains no browser, Git, loom, account, or agent controls: the vNext engine does not provide those records yet.</p></div></aside>}
  </>;
}
