import { remoteErrorResponse } from "@/lib/remote/http";
import { clearPairing, mintPairing } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Mint a fresh one-time pairing token. THE ONLY RESPONSE THAT EVER CARRIES A
 * RAW PAIRING TOKEN — the panel turns it into a QR/fragment URL client-side
 * and it is never emitted again. Minting replaces any pending token.
 */
export function POST() {
  try {
    const { token, expiresAt } = mintPairing();
    return Response.json({ token, expiresAt }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}

export function DELETE() {
  try {
    clearPairing();
    return Response.json({ ok: true });
  } catch (error) {
    return remoteErrorResponse(error);
  }
}
