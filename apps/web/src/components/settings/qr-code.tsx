"use client";

import type { QrMatrix } from "@/lib/remote/qr";

/** One path, no dependencies client-side: the matrix arrives pre-encoded. */
export function QrCodeView({ matrix, className }: { matrix: QrMatrix; className?: string }) {
  const { size, bits } = matrix;
  let d = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (bits[y * size + x] === "1") d += `M${x} ${y}h1v1h-1z`;
    }
  }
  const padded = size + 4;
  return (
    <svg
      viewBox={`-2 -2 ${padded} ${padded}`}
      role="img"
      aria-label="Pairing QR code"
      className={className}
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={padded} height={padded} fill="white" />
      <path d={d} fill="black" />
    </svg>
  );
}
