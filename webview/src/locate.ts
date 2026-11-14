/** Map a record/field pair to its currently rendered row/column position. */
export interface CellPosition {
  row: number;
  col: number;
}

export function locateCell(
  rows: readonly { id: string }[],
  cols: readonly string[],
  rowId?: string,
  field?: string
): CellPosition | null {
  if (!rowId || !field) return null;
  const row = rows.findIndex((candidate) => candidate.id === rowId);
  const col = cols.indexOf(field);
  return row < 0 || col < 0 ? null : { row, col };
}
