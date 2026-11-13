/** Keep the workbook bottom above the keyboard, in the workbook's own origin. */
export function visibleWorkbookHeight(top: number, height: number, viewport: { top: number; height: number }): number {
  return Math.max(0, Math.min(top + height, viewport.top + viewport.height) - top);
}
