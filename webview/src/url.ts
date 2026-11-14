/**
 * Only explicit, user-facing URL schemes are allowed in link cells.
 * Relative vault paths are intentionally not turned into browser URLs here;
 * Obsidian wiki links have their own [[...]] handling.
 */
export function safeExternalHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}
