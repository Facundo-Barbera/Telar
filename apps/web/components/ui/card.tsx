import * as React from "react"

import { cn } from "@/lib/utils"

/** What tints a card. `warning` is the shape asking for a decision. */
export type CardTone = "default" | "warning"

/**
 * THE CARD SHAPE, IN ONE PLACE — radius, fill and hairline, nothing else.
 *
 * Telar drew four cards at three radii: this primitive, the approval card, a
 * tally strip (since decommissioned) and a sidebar row. Three of them were
 * hand-rolled restatements of the same box, which is how they came to disagree
 * about how round a card is. `rounded-xl` is 14px here (--radius-xl, i.e.
 * --radius × 1.4) and it is also iOS `Theme.radiusCard` — practice on both
 * platforms, and now the documented ladder too (see globals.css --radius).
 *
 * IT IS A STRING, NOT A COMPONENT, because two of the three call sites are not
 * a `<div>`: the question card is a `<form>` and the two approval cards are
 * `<section>`s carrying an aria-label. A primitive that can only render a div
 * would have cost them their element, and an element is not a style choice.
 * SPACING IS DELIBERATELY ABSENT — `Card` owns a --card-spacing model its
 * header/content/footer slots read, and the hand-built cards use a flat `p-3`;
 * unifying the shape does not require unifying the padding, and pretending
 * otherwise is what would have turned this into a rewrite.
 *
 * A WARNING CARD IS A CARD WITH A TINT, not its own object. It differs from a
 * neutral one by exactly two declarations, and the ring carries the warning at
 * 40% where the fill carries it at 5% — the hairline is what a person reads as
 * "this one is waiting on me" from across the transcript.
 */
export function cardSurface(tone: CardTone = "default"): string {
  return tone === "warning"
    ? "rounded-xl bg-warning/5 ring-1 ring-warning/40"
    : "rounded-xl bg-card ring-1 ring-foreground/10"
}

function Card({
  className,
  size = "default",
  tone = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm"; tone?: CardTone }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-tone={tone}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        cardSurface(tone),
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
