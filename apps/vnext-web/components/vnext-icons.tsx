import type { SVGProps } from "react";

/**
 * One stroke set, drawn on a 24-grid.
 *
 * The transcript's icon vocabulary is deliberately small and literal — terminal,
 * file, pencil, globe, wrench — because the activity lane is meant to be uniform
 * and boring. An icon per tool would turn a forty-step turn into a sticker
 * album; the icon's job is only to say WHICH KIND of thing happened, and the
 * mono preview beside it says what.
 */
export type IconName =
  | "menu" | "home" | "folder" | "message" | "plus" | "settings" | "search" | "panel" | "close" | "refresh" | "chevron"
  | "terminal" | "file" | "pencil" | "globe" | "wrench" | "bot" | "list" | "shield" | "square" | "spinner"
  | "enter" | "check" | "circle" | "alert" | "arrowDown" | "sparkle";

const paths: Record<IconName, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Zm6 11v-6h6v6",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z",
  message: "M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v8Z",
  plus: "M12 5v14M5 12h14",
  settings: "M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Zm0-12.25v2m0 14v2M21 12h-2M5 12H3m15.36-6.36-1.42 1.42M7.06 16.94l-1.42 1.42m12.72 0-1.42-1.42M7.06 7.06 5.64 5.64",
  search: "m20 20-4.2-4.2M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z",
  panel: "M4 4h16v16H4zM14 4v16",
  close: "m6 6 12 12M18 6 6 18",
  refresh: "M20 11a8 8 0 1 0 2 5.4M20 4v7h-7",
  chevron: "m8 10 4 4 4-4",

  terminal: "m4 17 6-5-6-5m8 10h8",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5",
  pencil: "M4 20h4L20 8a2.83 2.83 0 0 0-4-4L4 16v4Zm10-14 4 4",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z",
  wrench: "M15.5 8.5a4 4 0 0 1-5.06 5.06L5 19l-1.5-1.5 5.44-5.44A4 4 0 0 1 14 6l-2.5 2.5 2 2L16 8Z",
  bot: "M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm5 0V4M9 13h.01M15 13h.01",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  shield: "M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-2.5 8.5 2 2 3.5-3.5",
  square: "M7 7h10v10H7z",
  spinner: "M12 3a9 9 0 1 0 9 9",
  // ↵ — the send glyph. Deliberately a return key, not a paper plane: the
  // button says which KEY sends, which is what a keyboard-first surface needs.
  enter: "M20 5v6a3 3 0 0 1-3 3H5m0 0 4-4m-4 4 4 4",
  check: "m5 13 4 4L19 7",
  circle: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  alert: "M12 3 2 20h20L12 3Zm0 6v5m0 3h.01",
  arrowDown: "M12 5v14m0 0 6-6m-6 6-6-6",
  // ✻ — the thinking mark.
  sparkle: "M12 4v16M4.5 7.5l15 9M19.5 7.5l-15 9",
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><path d={paths[name]} /></svg>;
}
