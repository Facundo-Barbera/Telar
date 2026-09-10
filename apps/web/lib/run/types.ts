/**
 * The run wire shapes, as the cockpit reads them.
 *
 * THIS IS NOW A RE-EXPORT, WHICH IS WHAT IT ALWAYS SAID IT WOULD BECOME. These
 * types were mirrored here while `packages/engine-client/src/protocol` was being
 * restructured by another writer — a second author in that file would have cost
 * more than the duplication did. The protocol module (`protocol/run.ts`) now
 * exists, so the mirror is gone and this file is the seam that let every
 * consumer keep importing `@/lib/run/types` throughout.
 *
 * SECRET VALUES ARE ABSENT FROM THE VIEW BY CONSTRUCTION. `RunEnvView` has no
 * `value` when `secret` is true, so a component cannot render one by mistake and
 * a screenshot of this panel cannot leak one.
 */
export type {
  RunConfigurationDraft,
  RunConfigurationView,
  RunEnvView,
  RunOutputAnswer,
  RunOutputLine,
  RunReadiness,
  RunStatus,
  RunStatusAnswer,
  RunView,
} from "@telar/engine-client";
