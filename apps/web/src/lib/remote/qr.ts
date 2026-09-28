import QRCode from "qrcode";

/**
 * Server-side QR encoding. The pairing URL becomes a module bitstring here
 * and is rendered as one SVG path client-side — the token is NEVER an
 * <img src> URL, so it cannot land in request logs or a browser cache key.
 */
export interface QrMatrix {
  size: number;
  /** Row-major "0"/"1" characters, size×size of them. */
  bits: string;
}

export function encodeQr(text: string): QrMatrix {
  const code = QRCode.create(text, { errorCorrectionLevel: "M" });
  const { size, data } = code.modules;
  let bits = "";
  for (const cell of data) bits += cell ? "1" : "0";
  return { size, bits };
}
