import type { Mark, Point } from "../annotation";

// Painted into a PNG that leaves the app, so literal colours rather than theme tokens.
const INK = "#ef4444";
const INK_SOFT = "rgba(239, 68, 68, 0.16)";
export const PICK = "#2563eb";
export const PICK_SOFT = "rgba(37, 99, 235, 0.14)";

function arrowHead(from: Point, to: Point): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 14;
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

/** The marks onto a 2D context at the frame's own scale: the PNG's half of `MarkShape`. */
export function paintMarks(context: CanvasRenderingContext2D, marks: readonly Mark[]): void {
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const mark of marks) {
    context.strokeStyle = mark.kind === "pick" ? PICK : INK;
    context.fillStyle = mark.kind === "pick" ? PICK_SOFT : INK_SOFT;
    context.lineWidth = 3;
    if (mark.kind === "rect") {
      context.fillRect(mark.box.x, mark.box.y, mark.box.width, mark.box.height);
      context.strokeRect(mark.box.x, mark.box.y, mark.box.width, mark.box.height);
    } else if (mark.kind === "pick") {
      const { x, y, width, height } = mark.element;
      context.fillRect(x, y, width, height);
      context.setLineDash([6, 4]);
      context.strokeRect(x, y, width, height);
      context.setLineDash([]);
    } else if (mark.kind === "arrow") {
      const [left, right] = arrowHead(mark.from, mark.to);
      context.beginPath();
      context.moveTo(mark.from.x, mark.from.y);
      context.lineTo(mark.to.x, mark.to.y);
      context.moveTo(left.x, left.y);
      context.lineTo(mark.to.x, mark.to.y);
      context.lineTo(right.x, right.y);
      context.stroke();
    } else if (mark.kind === "freehand") {
      context.beginPath();
      mark.points.forEach((point, at) => (at === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
      context.stroke();
    } else {
      context.font = "600 16px ui-sans-serif, system-ui, sans-serif";
      context.textBaseline = "top";
      const width = context.measureText(mark.text).width;
      context.fillStyle = "rgba(255,255,255,0.92)";
      context.fillRect(mark.at.x - 3, mark.at.y - 2, width + 6, 22);
      context.fillStyle = INK;
      context.fillText(mark.text, mark.at.x, mark.at.y);
    }
  }
}

/** One mark as SVG: the half drawn against while marking. */
export function MarkShape({ mark }: { mark: Mark }) {
  if (mark.kind === "rect") {
    return <rect x={mark.box.x} y={mark.box.y} width={mark.box.width} height={mark.box.height} fill={INK_SOFT} stroke={INK} strokeWidth={3} />;
  }
  if (mark.kind === "pick") {
    const { x, y, width, height } = mark.element;
    return <rect x={x} y={y} width={width} height={height} fill={PICK_SOFT} stroke={PICK} strokeWidth={3} strokeDasharray="6 4" />;
  }
  if (mark.kind === "arrow") {
    const [left, right] = arrowHead(mark.from, mark.to);
    return (
      <g fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} />
        <polyline points={`${left.x},${left.y} ${mark.to.x},${mark.to.y} ${right.x},${right.y}`} />
      </g>
    );
  }
  if (mark.kind === "freehand") {
    return (
      <polyline points={mark.points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    );
  }
  return (
    <text x={mark.at.x} y={mark.at.y} dominantBaseline="hanging" fill={INK} fontSize={16} fontWeight={600} paintOrder="stroke" stroke="rgba(255,255,255,0.92)" strokeWidth={4}>
      {mark.text}
    </text>
  );
}
