import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `text-xs-plus` HAS TO BE DECLARED A FONT SIZE, or it is read as a colour.
 *
 * tailwind-merge decides which group a `text-*` utility belongs to by testing
 * the suffix: anything shaped like a t-shirt size (`xs`, `sm`, `2xs`, `4xs`, …)
 * is a font size, and ANYTHING ELSE falls through to the text-colour group,
 * which accepts any suffix at all. `text-xs-plus` is not shaped like a t-shirt
 * size, so without this line `cn("text-xs-plus", "text-muted-foreground")`
 * would see two text-colour utilities, keep the last, and drop the size —
 * silently, at 13 call sites, rendering them at whatever they inherited.
 *
 * The other three steps of the sub-12px ramp (`text-4xs`, `text-3xs`,
 * `text-2xs`; see the @theme block in app/globals.css) already pass the
 * t-shirt test and need nothing here. This name does not, because the scale
 * has no room between `xs` and `sm` for a numbered one.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["xs-plus"] }] } },
});

/**
 * Join class names, letting the LAST conflicting Tailwind utility win.
 *
 * Plain `clsx` would keep both `px-2` and `px-4` and leave the winner to source
 * order in the compiled stylesheet, which is not something a component author
 * can reason about. `twMerge` makes `cn(base, props.className)` mean what every
 * shadcn primitive assumes it means: the caller can override.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
