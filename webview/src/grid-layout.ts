export const ROW_HEADER_KEY = "__rownum__";

export function rowHeaderWidth(widths: Record<string, number>): number {
  const saved = widths[ROW_HEADER_KEY];
  return Number.isFinite(saved) ? Math.max(44, Math.min(160, saved)) : 56;
}

export function gridWidth(cols: string[], widths: Record<string, number>): number {
  return rowHeaderWidth(widths) + cols.reduce((sum, col) => sum + (widths[col] ?? 160), 0) + 36;
}
