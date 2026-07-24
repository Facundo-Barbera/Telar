// LANE: delivery (UX BRAINSTORM 2026-07-23) — OWNED by the loom UX/UI
// session. FINAL DESIGN: the delivery shelf + taste-first card, converged
// from three proposals (the dossier / the coffee inbox / see-it-in-work) —
// all three survive inside it as altitudes of one judgment. Components under
// apps/web/lib/demo-gallery/delivery/**. Not part of the frozen six-lane
// redesign pass.
import type { DemoEntry } from "../registry";
import { DeliveryFinalDemo } from "../delivery/final";

export const deliveryEntries: DemoEntry[] = [
  {
    id: "delivery-final",
    title: "Delivery — final design",
    concern: "ux-delivery",
    variant: "Final · the shelf, then taste-first cards",
    summary:
      "The accept experience as one walkable surface. The SHELF is the fleet accept surface — an inbox of proven work, each delivery compressed to the 15-second skim (claim, proof strip, risk flags, release-grade badge) with the verdict in place, so 'read 7 over coffee, accept 5, bounce 2' never needs a tap-through. Opening a card is TASTE-FIRST: the ready product leads, served live by the frozen final-verify lane (cold checkout · shared warm infra · fresh tenant · release grade, lane URL on the glass), with a filmstrip flipping between the live lane and the ledger's screenshots. Below the glass, the courtroom scrolls: reality manifest, the cited narrative (the one uncited claim wears 'unverified'), the contract with per-assert citations, the provenance-stamped evidence ledger, the full attempt history with flaky flags, and the vision critic's advisory pre-verdict. The verdict bar rides the footer everywhere: Accept declares the map note and queues the silent landing; Boomerang opens the composer — sending it is the resume. One verdict per delivery, shared between shelf and card.",
    Component: DeliveryFinalDemo,
  },
];
