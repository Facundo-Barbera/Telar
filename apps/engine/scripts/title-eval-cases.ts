import type { TitleMessage } from "../src/domains/providers/title-context";

export type TitleEvalCase = {
  id: string;
  request: string;
  previousTitle: string;
  messages: TitleMessage[];
  rubric: string;
};

export const titleEvalCases: TitleEvalCase[] = [
  {
    id: "rail-flicker",
    request: "The rail re-sorts twice when a session settles; smooth the animation.",
    previousTitle: "New session",
    messages: [
      { role: "user", text: "The rail flickers when a session settles while another is streaming. Find why and make the settle animation smooth. Check it in the browser." },
      { role: "assistant", text: "The list re-sorts twice: once on the settle patch and again on the snapshot refresh." },
    ],
    rubric: "Name the rail settle flicker. The browser check is incidental.",
  },
  {
    id: "merge-after-green",
    request: "Add per-project run configurations, then merge when CI is green.",
    previousTitle: "Finish run config PR",
    messages: [
      { role: "user", text: "Let each project save its own run configurations for the Run menu." },
      { role: "assistant", text: "Run configurations now live per project and the Run menu lists them." },
      { role: "user", text: "Open a PR and merge it when CI is green." },
    ],
    rubric: "Keep per-project run configurations as the subject, not the merge.",
  },
  {
    id: "vague-opening",
    request: "A failing test turns out to be a journal compaction race.",
    previousTitle: "Fix failing test",
    messages: [
      { role: "user", text: "Fix this failing test." },
      { role: "assistant", text: "The journal compaction test races the writer: it reads the file before the last batch is flushed." },
    ],
    rubric: "Name the journal compaction race. Do not invent a wider storage problem.",
  },
  {
    id: "scope-change",
    request: "Change the goal from the QR layout to pairing token expiry, despite a long answer.",
    previousTitle: "Improve pairing QR layout",
    messages: [
      { role: "user", text: "Improve the pairing QR layout on the phone." },
      { role: "user", text: "Change of plan. Fix pairing token expiry. Keep remote access working." },
      { role: "assistant", text: "The token expires before the phone redeems it. " + "Implementation detail. ".repeat(800) },
      { role: "user", text: "Ship it." },
    ],
    rubric: "Name pairing token expiry and honour the explicit change of scope.",
  },
  {
    id: "review-umbrella",
    request: "Review the permission gate. One finding is a stale request index.",
    previousTitle: "Review permission gate risks",
    messages: [
      { role: "user", text: "Review the permission gate for risks." },
      { role: "assistant", text: "One finding is a stale request index after a restart. " + "Index detail. ".repeat(800) },
      { role: "user", text: "Fix the findings and watch CI." },
    ],
    rubric: "Keep the permission gate review as the scope. The previous title can stay.",
  },
  {
    id: "long-opening",
    request: "Investigate why Codex turns stall, keeping Claude untouched.",
    previousTitle: "Inspect logs",
    messages: [{ role: "user", text: "Investigate why Codex turns stall after steering. " + "Worker log line. ".repeat(800) + " Leave the Claude driver untouched." }],
    rubric: "Name Codex turns stalling after steering. The logs are evidence.",
  },
  {
    id: "orchestrated",
    request: "An orchestrator hands a builder the iOS Live Activity work, with process instructions.",
    previousTitle: "New session",
    messages: [
      { role: "system", text: "Orientation: you are a builder session." },
      { role: "user", text: "Make the iOS Live Activity show the running turn's elapsed time. Use a subagent to research, branch from origin/main, report with sessions_send when CI is green." },
      { role: "reasoning", text: "Planning the Live Activity timer." },
    ],
    rubric: "Name the Live Activity elapsed time. Subagents, branches and reporting are incidental.",
  },
  {
    id: "research",
    request: "How can session titles get better?",
    previousTitle: "Research title improvements",
    messages: [
      { role: "user", text: "How could Telar's session titles get better?" },
      { role: "assistant", text: "Title from the whole conversation, keep the user's messages first, and let people regenerate." },
      { role: "user", text: "Make those changes and open PRs. Watch until everything is green." },
    ],
    rubric: "Keep session titles as the subject, not the PRs.",
  },
];
