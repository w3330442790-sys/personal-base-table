export interface CellAddress {
  rowId: string;
  field: string;
}

function columnIndex(label: string): number {
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

/** Parse an Excel-style cell address (A1, $C$5) into the current sheet target. */
export function parseCellAddress(
  address: string,
  fields: readonly string[],
  records: readonly { id: string }[]
): CellAddress | null {
  const match = /^\s*\$?([A-Za-z]+)\$?([1-9]\d*)\s*$/.exec(address);
  if (!match) return null;
  const field = fields[columnIndex(match[1])];
  const record = records[Number(match[2]) - 1];
  return field && record ? { rowId: String(record.id), field } : null;
}
