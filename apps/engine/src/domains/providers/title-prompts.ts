import { limitTitleMessage } from "./title-context";

const TITLE_PROMPT = `Generate a title that will help the user recognize this coding session weeks later.
Return JSON with exactly one key: title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid quotes, labels, filler, and trailing punctuation.`;

const REGENERATE_TITLE_PROMPT = (previousTitle: string) => `Regenerate the title of an existing coding session so the user can recognize it weeks later.
The previous title was ${JSON.stringify(previousTitle)}.
Return JSON with exactly one key: title.

Determine the title in this order:
1. Read the USER messages first. Find the latest explicit durable goal. The original subject stays the subject until the user clearly changes what the session is about.
2. Use ASSISTANT messages to resolve vague links, unnamed code and discovered product nouns. Do not promote one assistant finding into the subject unless the user adopts it as a new goal.
3. Compare that subject with the previous title. Keep accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, names an artifact, reports completion, or the session contradicts it.
4. Title the durable subject and desired outcome, not the current state of the work.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Keep the umbrella subject when later messages focus on one finding, provider, platform or implementation detail.
- A session moving through research, planning, implementation, review, CI, merge and monitoring has usually not changed subject.
- Ignore deliverables and operations such as mocks, plans, branches, PRs, tests, CI, commits, merging and monitoring unless they are the actual topic.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name the reviewed feature or system and its durable concern, not one finding.
- For research, name the question domain rather than the research process.
- Do not claim the work is complete.
- Do not copy and truncate a message.
- Avoid PR numbers, quotes, labels, filler, and trailing punctuation.
- Keep the previous title if it is already accurate. Otherwise return a meaningfully better title, not a cosmetic paraphrase.`;

const MAX_PROMPT_CHARS = 8_000;
const EARLIER_TRUNCATED = "[Earlier content truncated]\n\n";

export function buildTitlePrompt(message: string): string {
  return `${TITLE_PROMPT}\n\nUser message:\n${limitTitleMessage(message, MAX_PROMPT_CHARS)}`;
}

export function buildRegenerateTitlePrompt(previousTitle: string, context: string): string {
  const contents = context.length <= MAX_PROMPT_CHARS ? context : `${EARLIER_TRUNCATED}${context.slice(-MAX_PROMPT_CHARS)}`;
  return `${REGENERATE_TITLE_PROMPT(previousTitle)}\n\nSession contents:\n${contents}`;
}
