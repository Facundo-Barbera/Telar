"use client";

/**
 * BACKDROP — the scene under the app (lib/backdrop.ts), as a settings group.
 *
 * The Scene control is three-way (None / Gradient / Image) but only "None"
 * writes the store directly: the other two reveal their picker, and the
 * PICKER writes the store when something is actually chosen — so flipping to
 * "Gradient" to browse never blanks an image already in place. The pickers
 * live in their own files (gradient-backdrop.tsx, image-backdrop.tsx).
 *
 * Strength is the SAME value as the Window group's translucency slider —
 * there is one see-through wash and one number for how far it opens, whether
 * the scene is the desktop or a gradient. It appears here whenever a scene is
 * set, so browser users get the control without the desktop-only group.
 */

import { useState } from "react";
import { MAX_TRANSLUCENCY, MIN_TRANSLUCENCY, useAppearance } from "@/lib/appearance";
import { useBackdrop } from "@/lib/backdrop";
import { Row, Segmented, SettingsGroup } from "./settings-shell";
import { GradientBackdrop } from "./gradient-backdrop";
import { ImageBackdrop } from "./image-backdrop";

type SceneView = "none" | "gradient" | "image";

export function BackdropSection() {
  const { appearance, setAppearance } = useAppearance();
  const { backdrop, setBackdrop } = useBackdrop();
  const storeView: SceneView = backdrop.kind === "none" ? "none" : backdrop.kind === "image" ? "image" : "gradient";
  // Local so a person can open a picker BEFORE anything is chosen; adjusted
  // during render (React's sanctioned derived-state idiom, not an effect) so
  // an outside write — theme-from-image setting an image — moves the control.
  const [view, setView] = useState<SceneView>(storeView);
  const [seenStoreView, setSeenStoreView] = useState<SceneView>(storeView);
  if (seenStoreView !== storeView) {
    setSeenStoreView(storeView);
    if (storeView !== "none") setView(storeView);
  }

  return (
    <SettingsGroup
      title="Backdrop"
      description="A scene under the whole app — the canvas and the rail frost over it. Works in every window, not just the desktop app."
    >
      <Row
        label="Scene"
        control={
          <Segmented<SceneView>
            value={view}
            onChange={(next) => {
              setView(next);
              if (next === "none") setBackdrop({ kind: "none" });
            }}
            options={[
              { value: "none", label: "None" },
              { value: "gradient", label: "Gradient" },
              { value: "image", label: "Image" },
            ]}
          />
        }
      />
      {view === "gradient" && <GradientBackdrop />}
      {view === "image" && <ImageBackdrop />}
      {backdrop.kind !== "none" && (
        <Row
          label="Strength"
          hint="How much of the scene shows through the canvas and the rail. Shared with the desktop window's translucency."
          control={
            <div className="flex items-center gap-2.5">
              <input
                type="range"
                min={MIN_TRANSLUCENCY}
                max={MAX_TRANSLUCENCY}
                step={5}
                value={appearance.translucencyLevel}
                onChange={(event) => setAppearance({ translucencyLevel: Number(event.target.value) })}
                className="w-36 accent-primary"
                aria-label="Backdrop strength"
              />
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{appearance.translucencyLevel}%</span>
            </div>
          }
        />
      )}
    </SettingsGroup>
  );
}
