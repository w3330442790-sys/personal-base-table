import type { FieldDef, FieldType, FilterCond, Row, SortSpec, ViewDef } from "../../src/core/types";

/** 对一个视图应用多条件筛选(AND) + 多字段排序 */
export function applyView(
  rows: Row[],
  view: ViewDef,
  fields: Record<string, FieldDef>
): Row[] {
  let out = rows;
  const filters = (view.filters ?? []).filter((c) => c.field);
  if (filters.length) {
    const any = view.filterMatch === "any";
    out = out.filter((r) =>
      any ? filters.some((c) => evalCond(r, c, fields)) : filters.every((c) => evalCond(r, c, fields))
    );
  }
  const sorts = (view.sorts ?? []).filter((s) => s.field);
  if (sorts.length) {
    out = multiSort(out, sorts, fields);
  }
  return out;
}

const str = (x: unknown) => String(x ?? "");

function evalCond(row: Row, cond: FilterCond, fields: Record<string, FieldDef>): boolean {
  const val = row.values[cond.field];
  const target = cond.value;
  const isEmpty = val == null || val === "" || (Array.isArray(val) && val.length === 0);
  switch (cond.op) {
    case "empty":
      return isEmpty;
    case "notEmpty":
      return !isEmpty;
    case "checked":
      return val === true;
    case "unchecked":
      return val !== true;
    case "is":
      return Array.isArray(val) ? val.map(str).includes(str(target)) : str(val) === str(target);
    case "isNot":
      return Array.isArray(val) ? !val.map(str).includes(str(target)) : str(val) !== str(target);
    case "contains":
      return Array.isArray(val) ? val.map(str).includes(str(target)) : str(val).includes(str(target));
    case "notContains":
      return Array.isArray(val) ? !val.map(str).includes(str(target)) : !str(val).includes(str(target));
    case "before":
      return str(val) !== "" && str(val) < str(target);
    case "after":
      return str(val) !== "" && str(val) > str(target);
    case "eq":
      return Number(val) === Number(target);
    case "ne":
      return Number(val) !== Number(target);
    case "gt":
      return Number(val) > Number(target);
    case "lt":
      return Number(val) < Number(target);
    case "gte":
      return Number(val) >= Number(target);
    case "lte":
      return Number(val) <= Number(target);
    default:
      return true;
  }
}

function emptyValue(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function multiSort(rows: Row[], sorts: SortSpec[], fields: Record<string, FieldDef>): Row[] {
  return [...rows].sort((a, b) => {
    for (const sp of sorts) {
      const av = a.values[sp.field];
      const bv = b.values[sp.field];
      // Empty cells stay at the end in both directions.
      if (emptyValue(av) || emptyValue(bv)) {
        if (emptyValue(av) && emptyValue(bv)) continue;
        return emptyValue(av) ? 1 : -1;
      }
      const r = cmp(av, bv, fields[sp.field]?.type);
      if (r !== 0) return sp.dir === "desc" ? -r : r;
    }
    return 0;
  });
}

function cmp(av: unknown, bv: unknown, type: FieldType | undefined): number {
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (type === "number") return Number(av) - Number(bv);
  return String(av).localeCompare(String(bv), "zh");
}
