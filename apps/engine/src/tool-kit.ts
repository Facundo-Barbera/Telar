/**
 * The seam every Telar toolkit is built on. Lifted out of `spool/tools.ts` and
 * `sessions-tools/tools.ts`, where the same four lines were duplicated so that
 * neither imported the provider SDK — a rule this file keeps: nothing here
 * touches the SDK, so a unit test drives any toolkit with a fake factory.
 */
export type ToolFactory = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
) => unknown;

export const ok = (text: string) => ({ content: [{ type: "text", text }] });
export const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
export const json = (value: unknown) => ok(JSON.stringify(value, null, 2));
export const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));
