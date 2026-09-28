import crypto from "node:crypto";

export const HOST_TOKEN_ENV = "TELAR_HOST_TOKEN";

export const HOST_HEADER = "x-telar-host";

export function readHostHeader(request: { headers: { get(name: string): string | null } }): string | null {
  return request.headers.get(HOST_HEADER);
}

function mintHostToken(): string {
  return "tlr_" + crypto.randomBytes(32).toString("base64url");
}

export function isHostToken(candidate: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env[HOST_TOKEN_ENV];
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof candidate !== "string" || candidate.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(secret, "utf8"));
}
