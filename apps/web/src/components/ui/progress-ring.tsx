/**
 * A DOWNLOAD'S PROGRESS, IN AN ICON'S SLOT — a ring that fills, with the
 * percentage centred inside it. It replaced a glyph with a number hung under
 * it, which collided with the glyph at the sidebar's size.
 *
 * 16px like the icons it sits among; the number is drawn in the SVG so it
 * scales with the ring rather than overflowing it. The arc eases between
 * readings, except under reduced motion.
 */
import { cn } from "@/lib/utils";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ProgressRing({ percent, label, className }: { percent: number; label: string; className?: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <svg
      viewBox="0 0 16 16"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={cn("size-4 shrink-0", className)}
    >
      <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5} />
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - value / 100)}
        transform="rotate(-90 8 8)"
        className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
      />
      <text x="8" y="8" textAnchor="middle" dominantBaseline="central" fontSize={value === 100 ? 5 : 6} fontWeight={600} fill="currentColor" className="tabular-nums">
        {value}
      </text>
    </svg>
  );
}
