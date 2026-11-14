import type { BaseDoc, FieldDef } from "../../src/core/types";
import { genId } from "../../src/core/types";
import { parseDelimited, typedValue } from "../../src/core/features";

export interface ImportOptions {
  header: boolean;
  sheetName?: string;
}

/** Detect the most likely delimiter from the first few lines, ignoring quoted text. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, "\t": 0, ";": 0 };
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 5; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "\n") {
      lines++;
      continue;
    }
    if (char in counts) counts[char]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

export function parseImportText(text: string): { matrix: string[][]; delimiter: string } {
  const delimiter = detectDelimiter(text);
  const matrix = parseDelimited(text.replace(/^\uFEFF/, ""), delimiter).filter((row) => row.some((cell) => cell.trim() !== ""));
  return { matrix, delimiter };
}

function uniqueNames(header: string[], width: number): string[] {
  const used = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const base = (header[index] ?? "").trim() || `列${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base} ${suffix++}`;
    used.add(name);
    return name;
  });
}

function inferField(values: string[]): FieldDef {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (!filled.length) return { type: "text" };
  if (filled.every((value) => /^[+-]?(?:\d+|\d*\.\d+)$/.test(value) && !/^[+-]?0\d/.test(value))) return { type: "number" };
  if (filled.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)) return { type: "date" };
  if (filled.every((value) => /^(true|false|1|0|是|否)$/i.test(value))) return { type: "checkbox" };
  return { type: "text" };
}

/** Build a new worksheet document from a CSV/TSV matrix. */
export function buildImportedDoc(matrix: string[][], options: ImportOptions): BaseDoc {
  if (!matrix.length) throw new Error("没有可导入的数据");
  const width = Math.max(...matrix.map((row) => row.length));
  const header = options.header ? matrix[0] : Array.from({ length: width }, (_, index) => `列${index + 1}`);
  const body = options.header ? matrix.slice(1) : matrix;
  const names = uniqueNames(header, width);
  const fields: Record<string, FieldDef> = {};
  names.forEach((name, index) => {
    fields[name] = inferField(body.map((row) => row[index] ?? ""));
  });
  const records: Record<string, unknown>[] = body.map((row) => {
    const record: Record<string, unknown> = { id: genId() };
    names.forEach((name, index) => {
      const raw = row[index] ?? "";
      if (!raw.trim()) return;
      record[name] = typedValue(raw, fields[name]);
    });
    return record;
  });
  return { fields, views: [{ name: "全部" }], records };
}

export function importSheetName(fileName: string): string {
  return fileName.replace(/\.(csv|tsv|txt|md)$/i, "").trim() || "导入表格";
}
