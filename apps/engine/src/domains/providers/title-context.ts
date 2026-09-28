import type { Item } from "@telar/engine-client";

export type TitleMessage = { role: "user" | "assistant" | "reasoning" | "system"; text: string };

const MAX_CONTEXT = 8_000;
const MAX_MESSAGE = 2_000;
const ASSISTANT_RESERVE = 2_000;
const OMITTED = "[Earlier content truncated]\n\n";
const TRUNCATED = "\n[Content truncated]\n";
const SEPARATOR = "\n\n";

export function limitTitleMessage(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return "";
  const available = budget - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${text.slice(0, head)}${TRUNCATED}${tail > 0 ? text.slice(-tail) : ""}`;
}

type Section = { index: number; role: "user" | "assistant"; prefix: string; text: string };

export function titleContext(messages: readonly TitleMessage[]): string {
  const sections: Section[] = messages.flatMap((message, index) => {
    const text = message.text.trim();
    if ((message.role !== "user" && message.role !== "assistant") || !text) return [];
    return [{ index, role: message.role, prefix: `${message.role.toUpperCase()}:\n`, text }];
  });
  const selected = new Map<number, string>();
  let remaining = MAX_CONTEXT - OMITTED.length;
  const add = (section: Section, budget: number) => {
    if (selected.has(section.index)) return;
    const limit = Math.min(budget, remaining) - section.prefix.length - SEPARATOR.length;
    if (limit <= TRUNCATED.length) return;
    const contents = limitTitleMessage(section.text, limit);
    if (!contents) return;
    const text = section.prefix + contents;
    selected.set(section.index, text);
    remaining -= text.length + SEPARATOR.length;
  };

  const latestFirst = [...sections].reverse();
  const firstUser = sections.find((section) => section.role === "user");
  if (firstUser) add(firstUser, MAX_MESSAGE);
  for (const section of latestFirst) if (section.role === "user") add(section, Math.min(MAX_MESSAGE, remaining - ASSISTANT_RESERVE));
  for (const section of latestFirst) if (section.role === "assistant") add(section, MAX_MESSAGE);
  for (const role of ["user", "assistant"] as const) {
    for (const section of latestFirst) {
      const previous = selected.get(section.index);
      if (section.role !== role || previous === undefined) continue;
      const expanded = section.prefix + limitTitleMessage(section.text, previous.length + remaining - section.prefix.length);
      remaining -= expanded.length - previous.length;
      selected.set(section.index, expanded);
    }
  }

  const retained = sections.filter((section) => selected.has(section.index));
  const shortened = retained.length < sections.length || retained.some((section) => selected.get(section.index) !== section.prefix + section.text);
  return `${shortened ? OMITTED : ""}${retained.map((section) => selected.get(section.index)).join(SEPARATOR)}`;
}

const ROLES: Partial<Record<Item["detail"]["type"], TitleMessage["role"]>> = {
  user_message: "user",
  assistant_message: "assistant",
  reasoning: "reasoning",
  notification: "system",
};

export function titleMessages(items: readonly Item[]): TitleMessage[] {
  return [...items]
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((item) => {
      const role = ROLES[item.detail.type];
      const text = "text" in item.detail && typeof item.detail.text === "string" ? item.detail.text : "";
      return role ? [{ role, text }] : [];
    });
}
