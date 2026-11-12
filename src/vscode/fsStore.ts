// VS Code 侧的文件读写:读文件 → 调 core 的纯函数 → 原子写回。对外保持原来按文件路径调用的接口。
import * as fs from "fs";
import * as path from "path";
import { BaseDoc, BaseTable, FieldDef, ViewDef } from "../core/types";
import { parseDoc, serializeDoc, toTable } from "../core/doc";
import * as ops from "../core/ops";
import { validateWorkbook } from "../core/workbook";
import { SNAPSHOT_ROOT, type SnapshotAdapter } from "../core/snapshots";

export function readDoc(file: string): BaseDoc {
  return parseDoc(fs.readFileSync(file, "utf8"), true);
}

export function readBase(file: string): BaseTable {
  return toTable(readDoc(file), file);
}

/** 原子写:写临时文件再 rename,避免写坏 */
export function writeDoc(file: string, doc: BaseDoc): void {
  const tmp = file + ".tmp-" + process.pid + "-" + globalThis.crypto.randomUUID();
  try {
    fs.writeFileSync(tmp, serializeDoc(doc), { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/** 读 → 改 → 写,返回操作的返回值 */
function mutate<T>(file: string, fn: (doc: BaseDoc) => T): T {
  const doc = readDoc(file);
  const out = fn(doc);
  writeDoc(file, doc);
  return out;
}

export const updateCell = (file: string, id: string, field: string, value: unknown) =>
  mutate(file, (d) => ops.updateCell(d, id, field, value));
export const addRow = (file: string, values: Record<string, unknown> = {}) => mutate(file, (d) => ops.addRow(d, values));
export const deleteRow = (file: string, id: string) => mutate(file, (d) => ops.deleteRow(d, id));
export const saveViews = (file: string, views: ViewDef[]) => mutate(file, (d) => ops.saveViews(d, views));
export const setField = (file: string, name: string, patch: Partial<FieldDef>) => mutate(file, (d) => ops.setField(d, name, patch));
export const renameField = (file: string, oldName: string, newName: string) =>
  mutate(file, (d) => ops.renameField(d, oldName, newName));
export const addField = (file: string, name: string, def: FieldDef, after?: string) =>
  mutate(file, (d) => ops.addField(d, name, def, after));
export function replaceAll(file: string, next: BaseDoc): void {
  const candidate = parseDoc(serializeDoc(next), true);
  validateWorkbook(candidate);
  writeDoc(file, candidate);
}
export const reorderFields = (file: string, names: string[]) => mutate(file, (d) => ops.reorderFields(d, names));
export const moveRow = (file: string, id: string, targetId: string) => mutate(file, (d) => ops.moveRow(d, id, targetId));
export const moveRowTo = (file: string, id: string, targetId: string, before = true) =>
  mutate(file, (d) => ops.moveRowTo(d, id, targetId, before));
export const duplicateField = (file: string, name: string) => mutate(file, (d) => ops.duplicateField(d, name));
export const deleteField = (file: string, name: string) => mutate(file, (d) => ops.deleteField(d, name));

const snapshotAdapters = new Map<string, SnapshotAdapter>();

/** All history paths remain beneath the selected workspace, including through symlinks. */
export function snapshotAdapter(directory: string): SnapshotAdapter {
  const root = path.resolve(directory);
  const cached = snapshotAdapters.get(root);
  if (cached) return cached;
  const resolve = async (relative: string): Promise<string> => {
    const parts = relative.split("/");
    if (parts[0] !== SNAPSHOT_ROOT || parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) {
      throw new Error("Invalid snapshot storage path");
    }
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error("Snapshot storage cannot contain symbolic links");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return current;
  };
  const adapter: SnapshotAdapter = {
    async exists(relative) {
      const target = await resolve(relative);
      try { await fs.promises.stat(target); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async mkdir(relative) { await fs.promises.mkdir(await resolve(relative)); },
    async read(relative) { return fs.promises.readFile(await resolve(relative), "utf8"); },
    async write(relative, data) { await fs.promises.writeFile(await resolve(relative), data, { encoding: "utf8", flag: "wx" }); },
    async remove(relative) { await fs.promises.unlink(await resolve(relative)); },
    async list(relative) {
      const entries = await fs.promises.readdir(await resolve(relative), { withFileTypes: true });
      return {
        files: entries.filter(entry => !entry.isDirectory()).map(entry => `${relative}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${relative}/${entry.name}`),
      };
    },
  };
  snapshotAdapters.set(root, adapter);
  return adapter;
}
