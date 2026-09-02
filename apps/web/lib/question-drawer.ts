import type { EngineRequest } from "@telar/engine-client";

/**
 * The question drawer's state, as pure folds.
 *
 * The drawer answers ONE `user_input` request — a list of choice fields — one
 * question at a time, with the composer's own editor doubling as the free-text
 * answer. Everything with judgement in it lives here so it is testable and so
 * the drawer and the composer cannot disagree: which answer wins, when the
 * user may advance, and what shape goes back to the engine.
 *
 * CUSTOM TEXT AND A SELECTED OPTION ARE MUTUALLY EXCLUSIVE. Typing clears the
 * selection; picking an option clears the text. Without that rule the submit
 * would have to invent a precedence at the moment it matters most, and the
 * screen would show two answers where one will be sent.
 */

export type QuestionField = {
  key: string;
  label: string;
  choices: string[];
};

export type QuestionDraft = {
  /** Which question is on screen, 0-based. */
  index: number;
  /** Selected option label, per field key. */
  selected: Record<string, string | undefined>;
  /** Free text typed in the composer, per field key. */
  custom: Record<string, string>;
};

export function emptyQuestionDraft(): QuestionDraft {
  return { index: 0, selected: {}, custom: {} };
}

/** The drawer's fields, from a request — empty when this request is not the
 *  all-choice `user_input` shape the drawer renders. */
export function questionFields(request: Pick<EngineRequest, "detail">): QuestionField[] {
  if (request.detail.kind !== "user_input") return [];
  const fields = request.detail.fields;
  if (fields.length === 0 || !fields.every((field) => field.kind === "choice" && (field.choices?.length ?? 0) > 0)) return [];
  return fields.map((field) => ({ key: field.key, label: field.label ?? field.key, choices: field.choices ?? [] }));
}

export function selectOption(draft: QuestionDraft, key: string, label: string): QuestionDraft {
  const already = draft.selected[key] === label;
  return {
    ...draft,
    // Picking the selected option again unpicks it — a toggle, so a changed
    // mind does not need a Clear button.
    selected: { ...draft.selected, [key]: already ? undefined : label },
    custom: { ...draft.custom, [key]: "" },
  };
}

export function setCustomAnswer(draft: QuestionDraft, key: string, text: string): QuestionDraft {
  return {
    ...draft,
    custom: { ...draft.custom, [key]: text },
    // Only a NON-EMPTY text evicts the selection: deleting back to empty must
    // not also forget the option picked before typing began.
    ...(text.trim() ? { selected: { ...draft.selected, [key]: undefined } } : {}),
  };
}

/** The answer one field would submit: the trimmed custom text when present,
 *  else the selected label, else nothing. */
export function answerFor(draft: QuestionDraft, key: string): string | undefined {
  const custom = draft.custom[key]?.trim();
  if (custom) return custom;
  return draft.selected[key];
}

/** Whether the question ON SCREEN has an answer — the gate on Next/Submit. */
export function canAdvance(fields: QuestionField[], draft: QuestionDraft): boolean {
  const field = fields[draft.index];
  return field !== undefined && answerFor(draft, field.key) !== undefined;
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

/**
 * The wire shape, or nothing. `undefined` unless EVERY field resolves — a
 * partial answers map would make the driver fill the gaps with "the user did
 * not answer", which is not what a submit button should be able to send.
 */
export function buildAnswers(fields: QuestionField[], draft: QuestionDraft): Record<string, string> | undefined {
  const answers: Record<string, string> = {};
  for (const field of fields) {
    const answer = answerFor(draft, field.key);
    if (answer === undefined) return undefined;
    answers[field.key] = answer;
  }
  return answers;
}
