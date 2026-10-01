import { z } from "zod";

type Shape = Record<string, unknown>;

export type CheckedArgs = { ok: true; args: Record<string, unknown> } | { ok: false; unknown: boolean; message: string };

export function strictArgs(shape: Shape): z.ZodObject {
  return z.strictObject(shape as Record<string, z.ZodType>);
}

export function checkArgs(name: string, shape: Shape, args: Record<string, unknown>): CheckedArgs {
  const parsed = strictArgs(shape).safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  const unknown = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknown) {
    const where = unknown.path.length > 0 ? `${name} \`${unknown.path.join(".")}\`` : name;
    const accepted = Object.keys(objectAt(shape, unknown.path) ?? {});
    return { ok: false, unknown: true, message: `${where} does not take ${unknown.keys.map((key) => `\`${key}\``).join(", ")}. It takes: ${accepted.join(", ") || "nothing"}.` };
  }
  return { ok: false, unknown: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}

function objectAt(shape: Shape, path: readonly PropertyKey[]): Shape | undefined {
  let current: unknown = z.object(shape as Record<string, z.ZodType>);
  for (const segment of path) {
    current = unwrap(current);
    if (current instanceof z.ZodArray) current = unwrap(current.element);
    if (typeof segment === "number") continue;
    if (!(current instanceof z.ZodObject)) return undefined;
    current = current.shape[segment as string];
  }
  current = unwrap(current);
  return current instanceof z.ZodObject ? current.shape : undefined;
}

function unwrap(schema: unknown): unknown {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) current = current.unwrap();
  return current;
}
