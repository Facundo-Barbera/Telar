import { type DriverRun, normalizeOutcome, questionChoices } from "../contract";
import { type SdkCanUseTool } from "./sdk";
import { parseToolName, TELAR_BROWSER_MCP_SERVER, type UserInputField } from "@telar/engine-client";
import { asRecord, str, requestKindForTool, requestDetailForToolCall } from "./mapping";

/** The gate, built around whichever `onRequest` a turn carries — this
 *  turn's, or a provider turn's own (see the idle pump). */
export const gateFor = (onRequest: NonNullable<DriverRun["onRequest"]>): SdkCanUseTool =>
  async (toolName, input, options) => {
      if (parseToolName(toolName).server === TELAR_BROWSER_MCP_SERVER) return { behavior: "allow" };
      if (toolName === "AskUserQuestion") {
        const questions = Array.isArray(asRecord(input).questions)
          ? (asRecord(input).questions as unknown[]).map(asRecord)
          : [];
        const fields = questions.flatMap((question): UserInputField[] => {
          const text = str(question.question);
          if (!text) return [];
          return [{
            key: text,
            label: text,
            kind: "choice",
            ...questionChoices(question),
            ...(question.multiSelect === true ? { multiple: true } : {}),
            required: true,
          }];
        });
        if (fields.length > 0) {
          try {
            const outcome = normalizeOutcome(
              await onRequest({
                kind: "user_input",
                detail: { kind: "user_input", prompt: "The agent needs your input to continue.", fields },
                toolUseId: options.toolUseID,
                signal: options.signal,
              }),
            );
            if (outcome.decision === "cancel") {
              return { behavior: "deny", message: "The human cancelled this turn.", interrupt: true };
            }
            if ((outcome.decision === "accept" || outcome.decision === "acceptForSession") && outcome.answers) {
              const answers: Record<string, string> = {};
              for (const field of fields) {
                const value = outcome.answers[field.key];
                if (value === undefined) continue;
                if (!Array.isArray(value)) {
                  answers[field.key] = String(value);
                  continue;
                }
                if (field.multiple) answers[field.key] = value.join(", ");
                else if (value.length > 0) answers[field.key] = String(value[0]);
              }
              return { behavior: "allow", updatedInput: { ...asRecord(input), answers } };
            }
          } catch {
            // Fall through: an unanswerable question is a DISMISSED one,
            // never a hang — same rule as the generic arm below.
          }
          // Declined, or answered with nothing: the tool's own graceful
          // arm ("the user did not answer") beats a deny that reads as a
          // broken tool.
          return { behavior: "allow" };
        }
      }
      try {
        const { decision } = normalizeOutcome(
          await onRequest({
            kind: requestKindForTool(toolName),
            detail: requestDetailForToolCall(toolName, input),
            toolUseId: options.toolUseID,
            signal: options.signal,
          }),
        );
        if (decision === "accept" || decision === "acceptForSession") return { behavior: "allow" };
        // `cancel` withdraws the whole turn rather than just this call.
        return {
          behavior: "deny",
          message: decision === "cancel" ? "The human cancelled this turn." : "The human declined this tool call.",
          ...(decision === "cancel" ? { interrupt: true } : {}),
        };
      } catch (error) {
        return { behavior: "deny", message: error instanceof Error ? error.message : "permission request failed" };
      }
    };
