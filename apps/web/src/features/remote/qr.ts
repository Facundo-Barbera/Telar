import QRCode from "qrcode";

export interface QrMatrix {
  size: number;
  bits: string;
}

export function encodeQr(text: string): QrMatrix {
  const code = QRCode.create(text, { errorCorrectionLevel: "M" });
  const { size, data } = code.modules;
  let bits = "";
  for (const cell of data) bits += cell ? "1" : "0";
  return { size, bits };
}
