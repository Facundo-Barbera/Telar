import type { EngineRequest, UserInputField } from "@telar/engine-client";

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
 * screen would show two answers where one will be sent. It holds on a MULTI
 * question too: a typed answer replaces the whole list, not the last pick.
 *
 * A DRAFT ALWAYS HOLDS A LIST, whatever the field's kind. A single question is
 * the list capped at one — which is why picking replaces rather than appends
 * there — so the two kinds differ in one fold instead of in two state shapes.
 */

/**
 * THE CONTRACT, READ EARLY. `packages/engine-client`'s `UserInputField` does
 * not carry `multiple` yet — the sibling change adds it. Until then this alias
 * is the web's whole view of the flag, and `isMultiChoice` below is its only
 * reader. DELETE BOTH the alias and the cast inside `isMultiChoice` when the
 * package lands; nothing else in the app touches the shim.
 */
type MultiCapableField = UserInputField & { multiple?: boolean };

/** Whether the agent asked for any number of these choices rather than one.
 *  The drawer and the approval card share this reader so the shim above has a
 *  single home to delete. */
export function isMultiChoice(field: UserInputField): boolean {
  return field.kind === "choice" && (field as MultiCapableField).multiple === true;
}

export type QuestionField = {
  key: string;
  label: string;
  choices: string[];
  /** Any number of choices, not one. Drives the toggle, the mark, and whether
   *  a pick auto-advances. */
  multiple: boolean;
};

export type QuestionDraft = {
  /** Which question is on screen, 0-based. */
  index: number;
  /** Chosen option labels, per field key. One at most on a single question,
   *  any number on a multi; empty and absent both mean unanswered. */
  selected: Record<string, string[] | undefined>;
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
    // Picking a chosen option again unpicks it — a toggle on BOTH kinds, so a
    // changed mind never needs a Clear button. The kinds differ only in what
    // survives the pick: a multi keeps the rest of the list, a single replaces
    // it, because "one answer" is the whole of what that question asked for.
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
    // Only a NON-EMPTY text evicts the selection: deleting back to empty must
    // not also forget the options picked before typing began.
    ...(text.trim() ? { selected: { ...draft.selected, [key]: [] } } : {}),
  };
}

/**
 * The answer one field would submit: the trimmed custom text when present,
 * else the chosen labels, else nothing.
 *
 * THE SHAPE FOLLOWS THE FIELD'S KIND, not what the human happened to do. A
 * multi field always answers with an array — custom text included, as a
 * one-element list — because the driver on the other side unpacks the shape
 * the field promised, and a bare string there would be a different type
 * arriving under the same key.
 */
export function answerFor(draft: QuestionDraft, field: QuestionField): string | string[] | undefined {
  const custom = draft.custom[field.key]?.trim();
  if (custom) return field.multiple ? [custom] : custom;
  const chosen = draft.selected[field.key] ?? [];
  if (chosen.length === 0) return undefined;
  return field.multiple ? chosen : chosen[0];
}

/** Whether the question ON SCREEN has an answer — the gate on Next/Submit. */
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

/**
 * The wire shape, or nothing. `undefined` unless EVERY field resolves — a
 * partial answers map would make the driver fill the gaps with "the user did
 * not answer", which is not what a submit button should be able to send.
 */
export function buildAnswers(fields: QuestionField[], draft: QuestionDraft): Record<string, string | string[]> | undefined {
  const answers: Record<string, string | string[]> = {};
  for (const field of fields) {
    const answer = answerFor(draft, field);
    if (answer === undefined) return undefined;
    answers[field.key] = answer;
  }
  return answers;
}
