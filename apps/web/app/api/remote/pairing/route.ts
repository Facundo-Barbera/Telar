import { listEndpoints } from "@/lib/remote/endpoints";
import { remoteErrorResponse } from "@/lib/remote/http";
import { encodeQr, type QrMatrix } from "@/lib/remote/qr";
import { clearPairing, mintPairing } from "@/lib/remote/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function webPort(): number {
  const raw = Number(process.env.PORT ?? process.env.TELAR_WEB_PORT ?? 3000);
  return Number.isInteger(raw) && raw > 0 ? raw : 3000;
}

/**
 * Mint a fresh one-time pairing code. THE ONLY RESPONSE THAT EVER CARRIES A
 * RAW PAIRING CODE. The QR matrices are encoded HERE, per QR-safe endpoint,
 * so the client renders bits rather than ever putting the code in an image
 * URL. Minting replaces any pending code.
 */
export function POST() {
  try {
    const { code, expiresAt } = mintPairing();
    const qrByUrl: Record<string, QrMatrix> = {};
    for (const endpoint of listEndpoints(webPort())) {
      if (!endpoint.qrSafe) continue;
      qrByUrl[endpoint.url] = encodeQr(`${endpoint.url}/pair#token=${code}`);
    }
    return Response.json({ code, expiresAt, qrByUrl }, { headers: { "cache-control": "no-store" } });
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
