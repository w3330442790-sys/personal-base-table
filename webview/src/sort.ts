import type { SortSpec } from "../../src/core/types";

/** Header click cycle: unsorted -> ascending -> descending -> unsorted. */
export function nextSort(sorts: SortSpec[], field: string): SortSpec[] {
  const current = sorts.find((sort) => sort.field === field);
  if (!current) return [{ field, dir: "asc" }];
  if (current.dir === "asc") return [{ field, dir: "desc" }];
  return [];
}

export function sortDirection(sorts: SortSpec[] | undefined, field: string): "asc" | "desc" | undefined {
  return sorts?.find((sort) => sort.field === field)?.dir;
}
