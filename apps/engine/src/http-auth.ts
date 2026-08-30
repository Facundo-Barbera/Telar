import crypto from "node:crypto";

/** ONE implementation of the bearer check, shared by the daemon and every
 *  socket the engine serves. Timing-safe: a comparison that leaks a prefix
 *  match would let a caller binary-search a token. */
export function bearerIsValid(value: string | undefined, token: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
