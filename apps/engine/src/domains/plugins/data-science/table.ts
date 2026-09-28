/**
 * A window of rows from a delimited file, for the table viewer. Parsed here,
 * in TypeScript, so a CSV opens with no kernel; a Parquet file goes through
 * pandas in `sessionTable`. RFC 4180 quoting, no more — a CSV that needs a
 * dialect sniffer needs pandas, and the viewer says so when this fails.
 */
export type TableWindow = {
  path: string;
  columns: string[];
  dtypes?: string[];
  total: number;
  offset: number;
  rows: unknown[][];
  truncated?: boolean;
};

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** A guess per column from the first 200 rows: number, boolean, or string. */
function inferTypes(rows: string[][], width: number): string[] {
  const types: string[] = [];
  for (let c = 0; c < width; c++) {
    let numeric = true;
    let boolean = true;
    let seen = 0;
    for (const row of rows.slice(0, 200)) {
      const v = row[c];
      if (v === undefined || v === "") continue;
      seen++;
      if (!NUMERIC.test(v)) numeric = false;
      if (!/^(true|false)$/i.test(v)) boolean = false;
      if (!numeric && !boolean) break;
    }
    types.push(seen === 0 ? "string" : numeric ? "number" : boolean ? "boolean" : "string");
  }
  return types;
}

export function windowCsv(text: string, delimiter: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }): Omit<TableWindow, "path"> {
  const all = parseDelimited(text, delimiter);
  const header = all[0] ?? [];
  const body = all.slice(1);
  const dtypes = inferTypes(body, header.length);
  let rows: unknown[][] = body.map((row) => row.map((v, c) => (dtypes[c] === "number" && v !== "" ? Number(v) : v)));
  if (options.sort) {
    const c = header.indexOf(options.sort);
    if (c >= 0) {
      const dir = options.desc ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = a[c] as string | number;
        const y = b[c] as string | number;
        if (x === y) return 0;
        if (x === "" || x === undefined) return 1;
        if (y === "" || y === undefined) return -1;
        return (x < y ? -1 : 1) * dir;
      });
    }
  }
  return { columns: header, dtypes, total: rows.length, offset: options.offset, rows: rows.slice(options.offset, options.offset + options.limit) };
}
