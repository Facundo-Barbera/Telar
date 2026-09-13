"use client";

/**
 * THE TWO MARKS A PROFILE WEARS, and the controls that set them — a glyph from
 * the app's closed set, and one of eight identity hues.
 *
 * WHY A PROFILE IS MARKED AT ALL. The browser panel's toolbar has room for about
 * one glyph, so a session that shows its identity by NAME either truncates it to
 * nothing or eats the row. An icon in a colour fits, and a person with three
 * Google accounts can tell at a glance which one a page was loaded with — which
 * is the entire reason profiles exist.
 *
 * BOTH ARE OPTIONAL AND "NONE" IS OFFERED FIRST-CLASS. A profile nobody marked is
 * an ordinary profile; the swatch row ends in a dashed ring and the icon grid
 * starts with one, so clearing is a click rather than a thing you cannot express.
 *
 * THE COLOUR IS AN IDENTITY, NOT A STATE — the same law the Spool's hues carry.
 * Nothing here derives a colour from whether a profile is the default, is in use,
 * or has a problem; a person picks it and it means whose it is.
 */

import { IDENTITY_COLORS, TELAR_ICONS, type IdentityColor, type TelarIcon } from "@telar/engine-client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { identityColorVar, IdentityIcon } from "@/lib/telar-icons";
import { cn } from "@/lib/utils";

/** The trigger both pickers hang off: the current mark, at row-control size. */
const TRIGGER = "flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted";

export function ProfileIconPicker({
  profile,
  icon,
  disabled,
  onPick,
}: {
  /** Only for the accessible name — a picker in a list of them has to say which
   *  profile it belongs to, or every one of them is called "Icon". */
  profile: string;
  icon?: TelarIcon | string;
  disabled?: boolean;
  onPick: (icon: TelarIcon | null) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          /* The trigger shows the glyph WITHOUT its colour: the swatch beside it
             is where the colour is set and read, and two controls painting the
             same hue would make one of them look like a duplicate of the other. */
          <button type="button" disabled={disabled} aria-label={`Icon for ${profile}`} title={`Icon for ${profile}`} className={TRIGGER}>
            <IdentityIcon icon={icon} className="size-4" />
          </button>
        }
      />
      <PopoverContent align="end" aria-label={`Icon for ${profile}`} className="w-64 p-2">
        <div className="grid grid-cols-8 gap-1" role="radiogroup" aria-label={`Icon for ${profile}`}>
          <button
            type="button"
            role="radio"
            aria-checked={!icon}
            aria-label="No icon"
            title="No icon"
            onClick={() => onPick(null)}
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted",
              !icon && "bg-muted text-foreground ring-1 ring-ring",
            )}
          >
            <IdentityIcon className="size-4 opacity-50" />
          </button>
          {TELAR_ICONS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={icon === id}
              aria-label={id}
              title={id}
              onClick={() => onPick(id)}
              className={cn(
                "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                icon === id && "bg-muted text-foreground ring-1 ring-ring",
              )}
            >
              <IdentityIcon icon={id} className="size-4" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProfileColorPicker({
  profile,
  color,
  disabled,
  onPick,
}: {
  profile: string;
  color?: IdentityColor | string;
  disabled?: boolean;
  onPick: (color: IdentityColor | null) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" disabled={disabled} aria-label={`Colour for ${profile}`} title={`Colour for ${profile}`} className={TRIGGER}>
            <span
              aria-hidden
              className={cn("size-3.5 rounded-full", !color && "border border-dashed border-input")}
              style={color ? { backgroundColor: identityColorVar(color) } : undefined}
            />
          </button>
        }
      />
      <PopoverContent align="end" aria-label={`Colour for ${profile}`} className="w-auto p-2">
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label={`Colour for ${profile}`}>
          {IDENTITY_COLORS.map((token) => (
            <button
              key={token}
              type="button"
              role="radio"
              aria-checked={color === token}
              aria-label={token}
              title={token}
              onClick={() => onPick(token)}
              className={cn(
                "size-4 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                color === token && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: identityColorVar(token) }}
            />
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={!color}
            aria-label="No colour"
            title="No colour — the glyph keeps the surface's own"
            onClick={() => onPick(null)}
            className={cn(
              "size-4 shrink-0 rounded-full border border-dashed border-input outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !color && "ring-2 ring-ring ring-offset-2 ring-offset-background",
            )}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
