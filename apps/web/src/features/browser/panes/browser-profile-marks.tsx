"use client";

import { IDENTITY_COLORS, TELAR_ICONS, type IdentityColor, type TelarIcon } from "@telar/engine-client";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { identityColorVar, IdentityIcon } from "@/ui/telar-icons";
import { cn } from "@/ui/utils";

const TRIGGER = "flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted";

export function ProfileIconPicker({
  profile,
  icon,
  disabled,
  onPick,
}: {
  profile: string;
  icon?: TelarIcon | string;
  disabled?: boolean;
  onPick: (icon: TelarIcon | null) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
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
