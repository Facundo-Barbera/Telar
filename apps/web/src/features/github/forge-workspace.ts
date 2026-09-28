
import type { PanelTabParams } from "@/features/panel/index";

export type ForgeOpen = {
  numbers: readonly number[];
  at?: number;
};

export function emptyForge(): ForgeOpen {
  return { numbers: [] };
}

const OPEN_KEY = "open";
const AT_KEY = "at";

function forgeNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

export function readForgeOpen(params: PanelTabParams): ForgeOpen {
  const numbers: number[] = [];
  for (const part of (params[OPEN_KEY] ?? "").split(",")) {
    const number = forgeNumber(part.trim());
    if (number !== undefined && !numbers.includes(number)) numbers.push(number);
  }
  const at = forgeNumber((params[AT_KEY] ?? "").trim());
  return { numbers, ...(at !== undefined && numbers.includes(at) ? { at } : {}) };
}

export function forgeParams(open: ForgeOpen): PanelTabParams {
  if (open.numbers.length === 0) return {};
  return {
    [OPEN_KEY]: open.numbers.join(","),
    ...(open.at !== undefined && open.numbers.includes(open.at) ? { [AT_KEY]: String(open.at) } : {}),
  };
}

export function openForge(open: ForgeOpen, number: number): ForgeOpen {
  if (open.numbers.includes(number)) return { ...open, at: number };
  return { numbers: [...open.numbers, number], at: number };
}

export function closeForge(open: ForgeOpen, number: number): ForgeOpen {
  const index = open.numbers.indexOf(number);
  if (index === -1) return open;
  const numbers = open.numbers.filter((entry) => entry !== number);
  if (numbers.length === 0) return { numbers };
  const at = open.at === number ? (numbers[index] ?? numbers[numbers.length - 1]!) : open.at;
  return { numbers, ...(at !== undefined ? { at } : {}) };
}

export function activateForge(open: ForgeOpen, number: number): ForgeOpen {
  return open.numbers.includes(number) ? { ...open, at: number } : open;
}

export function showForgeList(open: ForgeOpen): ForgeOpen {
  return { numbers: open.numbers };
}

export function otherForgeNumbers(open: ForgeOpen, number: number): number[] {
  if (!open.numbers.includes(number)) return [];
  return open.numbers.filter((entry) => entry !== number);
}

export function forgeNumbersAfter(open: ForgeOpen, number: number): number[] {
  const index = open.numbers.indexOf(number);
  if (index === -1) return [];
  return open.numbers.slice(index + 1);
}
