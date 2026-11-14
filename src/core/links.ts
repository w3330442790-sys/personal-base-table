// [[笔记]] 链接:解析单元格值、笔记改名时批量替换。纯函数。
import { BaseDoc } from "./types";
import { getSheet, listSheets } from "./workbook";

/** 单元格值整体是 [[目标]] / [[目标|显示]] / [[目标#标题]] 时返回目标与显示文字 */
export function parseWikiLink(value: unknown): { target: string; label: string } | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^\[\[([^\]|]+?)(\|([^\]]+))?\]\]$/);
  if (!m) return null;
  const target = m[1].trim();
  return { target, label: (m[3] ?? target).trim() };
}

export interface RenameLinkOptions {
  /** 旧文件路径(可带 .md),用于更新 [[目录/笔记]] 这类完整路径链接 */
  oldPath?: string;
  /** 新文件路径(可带 .md) */
  newPath?: string;
  /**
   * 是否替换裸 [[笔记名]]。同名笔记存在多个时调用方应传 false,
   * 避免把指向另一篇同名笔记的链接一起改掉。
   */
  replaceBare?: boolean;
}

const trimMarkdownExtension = (path?: string): string | undefined => path?.replace(/\.md$/i, "");

/**
 * 笔记改名或移动后更新文档里的 wiki 链接。
 *
 * - 裸链接 [[旧名]] 只在 replaceBare 为 true 时改成新名;
 * - 完整路径链接 [[目录/旧名]] 按 oldPath/newPath 更新,即使只是移动目录;
 * - 保留别名 [[旧名|别名]]、标题/块引用 [[旧名#标题]] 和前面的 !。
 */
export function renameLinks(doc: BaseDoc, oldName: string, newName: string, options: RenameLinkOptions = {}): number {
  const oldPath = trimMarkdownExtension(options.oldPath);
  const newPath = trimMarkdownExtension(options.newPath);
  const replaceBare = options.replaceBare ?? (oldName !== newName);
  const pathChanged = !!oldPath && !!newPath && oldPath !== newPath;
  if ((!replaceBare || oldName === newName) && !pathChanged) return 0;

  let count = 0;
  const swap = (source: string): string => source.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (whole, target: string, alias = "") => {
    const hash = target.indexOf("#");
    const path = hash >= 0 ? target.slice(0, hash) : target;
    const suffix = hash >= 0 ? target.slice(hash) : "";
    let next = path;
    if (replaceBare && oldName && path === oldName && newName) next = newName;
    else if (pathChanged && path === oldPath) next = newPath!;
    if (next === path) return whole;
    count++;
    return `[[${next}${suffix}${alias}]]`;
  });

  for (const info of listSheets(doc)) for (const rec of getSheet(doc, info.id).records) {
    for (const [k, v] of Object.entries(rec)) {
      if (k === "id") continue;
      if (typeof v === "string" && v.includes("[[")) rec[k] = swap(v);
      else if (Array.isArray(v)) rec[k] = v.map((x) => (typeof x === "string" && x.includes("[[")) ? swap(x) : x);
    }
  }
  return count;
}
