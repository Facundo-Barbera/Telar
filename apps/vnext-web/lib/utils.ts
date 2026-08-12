import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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
