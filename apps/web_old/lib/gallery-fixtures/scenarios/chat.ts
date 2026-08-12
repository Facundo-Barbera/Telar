// GALLERY (delete with /gallery) — chat group: the god-view Chat tab seeded with
// a prior steerer conversation (SessionView renders the persisted history
// statically; the live stream is benign-stubbed).
import type { GalleryFixtureBundle } from "../index";
import { at, galleryId, makeAttempt, makeChat, makeLoom } from "../builders";

export const chatBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("chat-steerer-history"),
    label: "Chat · steerer history",
    group: "chat",
    description:
      "Open the Chat tab: a resumed steering session with its persisted transcript (a redirect the owner gave mid-build).",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("chat-steerer-history"),
      project: "aurora",
      kind: "custom",
      title: "CSV export for the events table",
      prompt: "Stream a CSV of the filtered events table to the browser.",
      state: "running",
      createdAt: at(0),
      updatedAt: at(500),
      attempts: [makeAttempt({ costUsd: 0.7, startedAt: at(120) })],
    }),
    threads: [],
    feed: [],
    chat: makeChat({
      id: galleryId("chat-steerer-history"),
      role: "steerer",
      loomId: galleryId("chat-steerer-history"),
      costUsd: 0.14,
      inputTokens: 8200,
      outputTokens: 1400,
      cacheReadTokens: 6100,
      contextTokens: 15700,
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: "Make sure the export respects the active column filter, not just the date range.",
            },
          ],
        },
        {
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Good catch — I'll thread the active filter into the export query so the CSV matches exactly what's on screen. Let me look at how the table builds its filter.",
            },
            {
              type: "tool",
              name: "Grep",
              input: { pattern: "buildFilter", path: "lib/events" },
              output: "lib/events/query.ts: export function buildFilter(params): SQL { … }",
            },
            {
              type: "text",
              text: "buildFilter() already produces the WHERE clause the table uses. I'll reuse it in the export route so there's a single source of truth for the filter.",
            },
          ],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "Perfect. Also cap the export at 100k rows and tell the user if it truncates." }],
        },
        {
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Will do — I'll add a 100k row cap and set an `X-Truncated: true` header plus a toast when the export is capped.",
            },
          ],
        },
      ],
    }),
    viewHints: ["chat"],
  },
];
