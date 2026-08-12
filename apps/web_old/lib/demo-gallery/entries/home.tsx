// LANE: home (UX BRAINSTORM 2026-07-23) — OWNED by the loom UX/UI session.
// FINAL: the active production dashboard, loom-aware — a graft, not a
// replacement (session verdict). The three from-scratch proposals
// (two-band triage / delivery inbox / the map) were superseded; their best
// ideas live on inside the graft: the needs-you split, judge-in-place rows,
// and the map drift note on hot projects. Components under
// apps/web/lib/demo-gallery/home/**. Not part of the frozen six-lane pass.
import type { DemoEntry } from "../registry";
import { HomeCurrentDemo } from "../home/current";

export const homeEntries: DemoEntry[] = [
  {
    id: "home-current",
    title: "Home — the active dashboard, loom-aware",
    concern: "ux-home",
    variant: "Final · graft, not replace",
    summary:
      "The dashboard you already have — same KPI hero (Running now / Needs you / Threads weaving / Spend today / plan meters), same two-column command deck, same 3px rails and panel grammar — with the loom era grafted into it. 'Needs you' moves to the top of the left column and splits into the two kinds of judgment: the ready DELIVERY as a compressed UX 3 shelf row (claim, proof tally, risk flag, Accept/Boomerang in place — accept queues the silent landing and declares its map note) and the PARKED QUESTION verbatim, where answering resumes the loom. 'Running now' rows keep their grammar and gain the window: act chip (prepare/build/verify/repair/parked) and live evidence age. The right column keeps Recent sessions first-class (looms are born there — 'New loom: search filters' sits in the list) and adds the Done-today receipt ('accepted 08:12 · landed silently') plus Hot projects carrying their map drift note ('drifting · 2 changes since Mon not on the map'). Nothing the current home does was removed.",
    Component: HomeCurrentDemo,
  },
];
