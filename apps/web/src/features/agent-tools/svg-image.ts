import type { Size } from "./viewport";

export type SvgImage = Size & { url: string };

const length = (value: string | null) => {
  const parsed = value && /^\s*\d+(\.\d+)?(px)?\s*$/.test(value) ? Number.parseFloat(value) : Number.NaN;
  return parsed > 0 ? parsed : undefined;
};

export function svgImage(source: string): SvgImage | undefined {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (svg.nodeName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) return undefined;
  const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = length(svg.getAttribute("width")) ?? (box.length === 4 && box[2]! > 0 ? box[2]! : 300);
  const height = length(svg.getAttribute("height")) ?? (box.length === 4 && box[3]! > 0 ? box[3]! : (width * 2) / 3);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const style = (svg.getAttribute("style") ?? "").replace(/max-width\s*:[^;]*;?/gi, "").trim();
  if (style) svg.setAttribute("style", style);
  else svg.removeAttribute("style");
  if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const text = new XMLSerializer().serializeToString(svg);
  return { width, height, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` };
}
