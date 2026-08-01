import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The hover deepens the fill rather than fading it. `bg-primary/80`
        // composites the primary toward whatever is behind the button, and
        // since the label is --primary-foreground the fill walking toward the
        // page walks toward the label: white on primary/80 was 4.22:1 light
        // and 4.49:1 dark, i.e. the app's main CTA dropped under AA exactly
        // while the pointer was on it. Mixing toward --foreground instead is
        // opaque (no backdrop to fade into) and self-correcting, because
        // --foreground and --primary-foreground sit on opposite sides of
        // --primary in each theme: light darkens, dark lightens, both land
        // near 7.2:1. Same shape the secondary variant below already uses.
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)]",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // Same trap as `default`, one layer down: here the label IS the token
        // the fill is made of, so every step of alpha moves the fill toward
        // the label. The old ladder (/10 -> /20 light, /20 -> /30 dark) put
        // the hovered state at 3.89:1 light and 3.86:1 dark on a card — under
        // AA on the delete button, exactly while it is being read.
        //
        // One ladder now serves both themes, which is why the dark fill
        // overrides are gone: /10 to /15 clears 4.5:1 on canvas, card AND
        // popover in light and dark alike. Popover is the one that forced it —
        // dialog.tsx is `bg-popover`, so a confirm dialog is where this button
        // most often lives, and dark /20 there was 4.38:1. The smaller fill
        // step gives up some hover punch; the border takes it back, using the
        // `border border-transparent` the base class already reserves.
        destructive:
          "bg-destructive/10 text-destructive hover:border-destructive/40 hover:bg-destructive/15 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      // A Button given a `render` element (e.g. render={<Link/>}) is no longer a
      // native <button>, so default nativeButton off — keeps Base UI's a11y
      // semantics correct and silences its warning. An explicit nativeButton wins.
      {...(props.render != null && props.nativeButton === undefined
        ? { nativeButton: false }
        : {})}
    />
  )
}

export { Button, buttonVariants }
