import type { BaseDoc } from "./types";

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  align?: "left" | "center" | "right";
}

export type StyleMap = Record<string, Record<string, CellStyle>>;

function styles(sheet: BaseDoc): StyleMap | undefined {
  return (sheet.personalGrid as { cellStyles?: StyleMap } | undefined)?.cellStyles;
}

export function cellStyle(sheet: BaseDoc, id: string, field: string): CellStyle {
  return styles(sheet)?.[id]?.[field] ?? {};
}

export function formatCells(sheet: BaseDoc, ids: string[], fields: string[], patch: Partial<CellStyle> | null): void {
  const rows = new Set(sheet.records.map(row => String(row.id)));
  if (ids.some(id => !rows.has(id)) || fields.some(field => !sheet.fields[field])) throw new Error("选区已变化，请重新选择单元格");
  if (!ids.length || !fields.length) return;
  const meta = (sheet.personalGrid ??= {}) as { cellStyles?: StyleMap };
  const map = (meta.cellStyles ??= {});
  for (const id of ids) {
    const row = (map[id] ??= {});
    for (const field of fields) {
      if (patch === null) { delete row[field]; continue; }
      const next = { ...row[field], ...patch };
      for (const key of ["bold", "italic", "underline", "strikethrough"] as const) if (!next[key]) delete next[key];
      if (Object.keys(next).length) row[field] = next;
      else delete row[field];
    }
    if (!Object.keys(row).length) delete map[id];
  }
  if (!Object.keys(map).length) delete meta.cellStyles;
}

export function toggleCellStyle(sheet: BaseDoc, ids: string[], fields: string[], key: "bold" | "italic" | "underline" | "strikethrough"): void {
  const enabled = ids.length > 0 && fields.length > 0 && ids.every(id => fields.every(field => cellStyle(sheet, id, field)[key]));
  formatCells(sheet, ids, fields, { [key]: !enabled });
}

export function cellStyleCss(style: CellStyle): {
  fontWeight?: number;
  fontStyle?: "italic";
  textDecorationLine?: string;
  textAlign?: CellStyle["align"];
} {
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecorationLine: [style.underline ? "underline" : "", style.strikethrough ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    textAlign: style.align,
  };
}

export function cellStyleHtml(style: CellStyle): string {
  const align = style.align && ["left", "center", "right"].includes(style.align) ? `text-align:${style.align}` : "";
  return [style.bold && "font-weight:700", style.italic && "font-style:italic", (style.underline || style.strikethrough) && `text-decoration:${[style.underline && "underline", style.strikethrough && "line-through"].filter(Boolean).join(" ")}`, align].filter(Boolean).join(";");
}
