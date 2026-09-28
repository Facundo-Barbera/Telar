"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EngineRequest } from "@telar/engine-client";
import {
  advance as advanceQuestion,
  buildAnswers,
  canAdvance,
  emptyQuestionDraft,
  isLastQuestion,
  questionFields,
  setCustomAnswer,
  type QuestionDraft,
} from "@/lib/question-drawer";

/** While a question is open the editor holds its custom answer; the real draft waits untouched underneath. */
export function useQuestionMode(
  question: EngineRequest | undefined,
  onAnswerQuestion: ((requestId: string, answers: Record<string, string | string[]>) => void) | undefined,
  draft: string,
) {
  const fields = useMemo(() => (question ? questionFields(question) : []), [question]);
  const active = fields.length > 0 && Boolean(onAnswerQuestion);
  // Keyed by request id, so one request's half-typed answer never leaks into the next.
  const [state, setState] = useState<{ requestId: string; draft: QuestionDraft }>();
  const answer = active && question && state?.requestId === question.id ? state.draft : emptyQuestionDraft();
  const setAnswer = (next: QuestionDraft) => question && setState({ requestId: question.id, draft: next });
  const activeKey = fields[answer.index]?.key;
  const boxText = active && activeKey !== undefined ? (answer.custom[activeKey] ?? "") : draft;

  /** True when the form moved on: advanced to the next field, or answered. */
  const advanceOrSubmit = (): boolean => {
    if (!question || !onAnswerQuestion || !canAdvance(fields, answer)) return false;
    if (!isLastQuestion(fields, answer)) {
      setAnswer(advanceQuestion(answer));
      return true;
    }
    const answers = buildAnswers(fields, answer);
    if (!answers) return false;
    onAnswerQuestion(question.id, answers);
    return true;
  };
  const advance = useRef(advanceOrSubmit);
  useLayoutEffect(() => {
    advance.current = advanceOrSubmit;
  });

  const typeAnswer = (text: string): boolean => {
    if (!active || activeKey === undefined) return false;
    setAnswer(setCustomAnswer(answer, activeKey, text));
    return true;
  };

  const submitLabel = isLastQuestion(fields, answer) ? (fields.length === 1 ? "Submit answer" : "Submit answers") : "Next question";

  return { fields, active, answer, setAnswer, boxText, advance, typeAnswer, submitLabel, canAdvance: canAdvance(fields, answer) };
}
