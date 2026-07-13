// GALLERY (delete with /gallery) — blocked group: the conversational escalation
// surface (park explanation + Discuss button; the quick-answer form). The chat
// NEVER auto-starts — the "chat-open" entry is the same surface after the
// reviewer clicks Discuss (documented hint, never injected).
import type { GalleryFixtureBundle } from "../index";
import { at, galleryId, makeLoom } from "../builders";

const blockedLoom = (slug: string) =>
  makeLoom({
    id: galleryId(slug),
    project: "finch",
    kind: "custom",
    title: "Publish the coverage badge from CI",
    prompt: "Wire the coverage number into a README badge on every main build.",
    state: "blocked",
    createdAt: at(0),
    updatedAt: at(240),
    blockedReason:
      "2 agent-judged assertions need a live target, but there is no devCommand, no servers recipe tier, and the setup agent is off — the verification lane is unachievable.",
    blockedQuestion:
      "How is this meant to be verified? It's a CI/badge change with no server to drive — do you have a test or eval command whose exit code proves the coverage number is published?",
  });

export const blockedBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("blocked-discuss"),
    label: "Blocked · discuss (pre-click)",
    group: "blocked",
    description:
      "A loom parked before building: the park explanation, the prominent Discuss button, and the secondary quick-answer form.",
    surface: "discuss",
    loom: blockedLoom("blocked-discuss"),
    threads: [],
    feed: [],
  },
  {
    id: galleryId("blocked-discuss-open"),
    label: "Blocked · discuss (chat open)",
    group: "blocked",
    description:
      "Click 'Discuss with the orchestrator' to mount the SessionView shell. The chat stream is benign-stubbed (a documented limitation).",
    surface: "discuss",
    loom: blockedLoom("blocked-discuss-open"),
    threads: [],
    feed: [],
    viewHints: ["click-discuss"],
  },
];
