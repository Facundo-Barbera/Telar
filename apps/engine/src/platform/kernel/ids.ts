import { EngineStateError } from "./errors";

export const ID = /^[A-Za-z0-9_-]+$/;

export function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new EngineStateError("invalid_request", `${label} must contain only letters, numbers, underscores, or hyphens`);
  }
}

// Neither half of a composite secret key (ids, env names) can contain a space.
export const SECRET_KEY_SEPARATOR = " ";
