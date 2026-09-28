export type CardTone = "default" | "warning"

export function cardSurface(tone: CardTone = "default"): string {
  return tone === "warning"
    ? "rounded-xl bg-warning/5 ring-1 ring-warning/40"
    : "rounded-xl bg-card ring-1 ring-foreground/10"
}
