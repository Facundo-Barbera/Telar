import type { EngineRequest, UserInputField } from "@telar/engine-client";

export function isMultiChoice(field: UserInputField): boolean {
  return field.kind === "choice" && field.multiple === true;
}

export type QuestionField = {
  key: string;
  label: string;
  choices: string[];
  multiple: boolean;
};

export type QuestionDraft = {
  index: number;
  selected: Record<string, string[] | undefined>;
  custom: Record<string, string>;
};

export function emptyQuestionDraft(): QuestionDraft {
  return { index: 0, selected: {}, custom: {} };
}

export function questionFields(request: Pick<EngineRequest, "detail">): QuestionField[] {
  if (request.detail.kind !== "user_input") return [];
  const fields = request.detail.fields;
  if (fields.length === 0 || !fields.every((field) => field.kind === "choice" && (field.choices?.length ?? 0) > 0)) return [];
  return fields.map((field) => ({
    key: field.key,
    label: field.label ?? field.key,
    choices: field.choices ?? [],
    multiple: isMultiChoice(field),
  }));
}

export function selectOption(draft: QuestionDraft, field: QuestionField, label: string): QuestionDraft {
  const chosen = draft.selected[field.key] ?? [];
  const already = chosen.includes(label);
  return {
    ...draft,
    selected: {
      ...draft.selected,
      [field.key]: field.multiple ? (already ? chosen.filter((one) => one !== label) : [...chosen, label]) : already ? [] : [label],
    },
    custom: { ...draft.custom, [field.key]: "" },
  };
}

export function setCustomAnswer(draft: QuestionDraft, key: string, text: string): QuestionDraft {
  return {
    ...draft,
    custom: { ...draft.custom, [key]: text },
    ...(text.trim() ? { selected: { ...draft.selected, [key]: [] } } : {}),
  };
}

export function answerFor(draft: QuestionDraft, field: QuestionField): string | string[] | undefined {
  const custom = draft.custom[field.key]?.trim();
  if (custom) return field.multiple ? [custom] : custom;
  const chosen = draft.selected[field.key] ?? [];
  if (chosen.length === 0) return undefined;
  return field.multiple ? chosen : chosen[0];
}

export function canAdvance(fields: QuestionField[], draft: QuestionDraft): boolean {
  const field = fields[draft.index];
  return field !== undefined && answerFor(draft, field) !== undefined;
}

export function isLastQuestion(fields: QuestionField[], draft: QuestionDraft): boolean {
  return draft.index >= fields.length - 1;
}

export function advance(draft: QuestionDraft): QuestionDraft {
  return { ...draft, index: draft.index + 1 };
}

export function back(draft: QuestionDraft): QuestionDraft {
  return { ...draft, index: Math.max(0, draft.index - 1) };
}

export function buildAnswers(fields: QuestionField[], draft: QuestionDraft): Record<string, string | string[]> | undefined {
  const answers: Record<string, string | string[]> = {};
  for (const field of fields) {
    const answer = answerFor(draft, field);
    if (answer === undefined) return undefined;
    answers[field.key] = answer;
  }
  return answers;
}
