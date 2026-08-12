import type { SVGProps } from "react";

export type IconName = "menu" | "home" | "folder" | "message" | "plus" | "settings" | "search" | "panel" | "close" | "refresh" | "chevron";

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
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><path d={paths[name]} /></svg>;
}
