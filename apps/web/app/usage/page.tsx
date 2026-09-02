import { UsagePage } from "@/components/usage/usage-page";

export const dynamic = "force-dynamic";

export default function Usage() {
  // `h-full`, not `h-dvh` — renders inside the app shell's inset, which is
  // already viewport-height (same reasoning as the settings route).
  return (
    <div className="h-full min-h-0">
      <UsagePage />
    </div>
  );
}
