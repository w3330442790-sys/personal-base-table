import type { BaseDoc } from "./types";

export const SNAPSHOT_ROOT = ".personal-base-table-history";
export interface SnapshotAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
export interface SnapshotLimits { maxCount?: number; maxBytes?: number }
export interface SnapshotMetadata { id: string; label: string; createdAt: string; doc?: BaseDoc }
export interface Snapshot extends SnapshotMetadata { doc: BaseDoc }

const queues = new WeakMap<SnapshotAdapter, Promise<unknown>>();
let sequence = 0;
const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function validateDoc(value: unknown): asserts value is BaseDoc {
  if (!isObject(value) || !isObject(value.fields) || !Array.isArray(value.views) || !Array.isArray(value.records)
    || !Object.values(value.fields).every(field => isObject(field) && typeof field.type === "string")
    || !value.views.every(view => isObject(view) && typeof view.name === "string")
    || !value.records.every(isObject)) throw new Error("Invalid snapshot document");
}

function directory(documentId: string): string {
  if (safeId.test(documentId)) return `${SNAPSHOT_ROOT}/id-${documentId}`;
  const parts = documentId.split("/");
  if (!/\.(wbase|base)$/i.test(documentId) || documentId.length > 2048
    || parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))
    || parts.includes(SNAPSHOT_ROOT)) throw new Error("Invalid snapshot document id or legacy path");
  const encoded = new TextEncoder().encode(documentId);
  const hex = Array.from(encoded, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${SNAPSHOT_ROOT}/legacy/${hex.match(/.{1,200}/g)!.join("/")}`;
}

function decode(text: string, expectedId: string): Snapshot {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid snapshot JSON"); }
  if (!isObject(value) || value.id !== expectedId || !safeId.test(expectedId)
    || typeof value.label !== "string" || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Invalid snapshot metadata");
  validateDoc(value.doc);
  return { id: expectedId, label: value.label, createdAt: value.createdAt, doc: value.doc };
}

/** Standalone, verified JSON snapshots. All operations sharing an adapter are serialized. */
export class SnapshotStore {
  private readonly maxCount: number;
  private readonly maxBytes: number;

  constructor(private readonly adapter: SnapshotAdapter, limits: SnapshotLimits = {}) {
    this.maxCount = limits.maxCount ?? 30;
    this.maxBytes = limits.maxBytes ?? 100 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxCount) || this.maxCount < 1
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Invalid snapshot limits");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = (queues.get(this.adapter) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(this.adapter, next.then(() => undefined, () => undefined));
    return next;
  }

  private async ensureDirectory(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (await this.adapter.exists(parent)) continue;
      try { await this.adapter.mkdir(parent); }
      catch (error) { if (!await this.adapter.exists(parent)) throw error; }
    }
  }

  private async entries(path: string): Promise<{ snapshot: Snapshot; path: string; bytes: number }[]> {
    if (!await this.adapter.exists(path)) return [];
    const listing = await this.adapter.list(path);
    const entries = [];
    for (const file of listing.files) {
      const name = file.slice(path.length + 1);
      if (!file.startsWith(path + "/") || name.includes("/") || !name.endsWith(".json") || !safeId.test(name.slice(0, -5))) {
        throw new Error("Invalid snapshot path in history directory");
      }
      const text = await this.adapter.read(file);
      entries.push({ snapshot: decode(text, name.slice(0, -5)), path: file, bytes: new TextEncoder().encode(text).length });
    }
    return entries.sort((a, b) => b.snapshot.createdAt.localeCompare(a.snapshot.createdAt) || b.snapshot.id.localeCompare(a.snapshot.id));
  }

  async create(documentId: string, label: string, doc: BaseDoc): Promise<SnapshotMetadata> {
    const path = directory(documentId);
    if (typeof label !== "string") throw new Error("Invalid snapshot label");
    // Capture ownership before waiting for other disk operations.
    const captured: unknown = JSON.parse(JSON.stringify(doc));
    validateDoc(captured);
    return this.serial(async () => {
      const id = `${Date.now().toString(36).padStart(10, "0")}-${(++sequence).toString(36).padStart(8, "0")}-${globalThis.crypto.randomUUID()}`;
      const snapshot: Snapshot = { id, label, createdAt: new Date().toISOString(), doc: captured };
      const text = JSON.stringify(snapshot);
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > this.maxBytes) throw new Error(`Snapshot is too large for the ${this.maxBytes}-byte limit`);
      // Validate existing history before creating a new file or pruning anything.
      const existing = await this.entries(path);
      await this.ensureDirectory(path);
      const file = `${path}/${id}.json`;
      try {
        await this.adapter.write(file, text);
        const saved = await this.adapter.read(file);
        decode(saved, id);
        if (saved !== text) throw new Error("Snapshot verification failed");
      } catch (error) {
        // A partial write must not poison subsequent list or retry operations.
        if (await this.adapter.exists(file)) await this.adapter.remove(file);
        throw error;
      }
      let count = 1;
      let total = bytes;
      for (const entry of existing) {
        if (count < this.maxCount && total + entry.bytes <= this.maxBytes) {
          count++;
          total += entry.bytes;
        } else await this.adapter.remove(entry.path);
      }
      return { id, label, createdAt: snapshot.createdAt };
    });
  }

  async list(documentId: string): Promise<SnapshotMetadata[]> {
    const path = directory(documentId);
    return this.serial(async () => (await this.entries(path)).map(({ snapshot }) => ({ id: snapshot.id, label: snapshot.label, createdAt: snapshot.createdAt })));
  }

  async read(documentId: string, snapshotId: string): Promise<Snapshot> {
    const path = directory(documentId);
    if (!safeId.test(snapshotId)) throw new Error("Invalid snapshot id");
    return this.serial(async () => decode(await this.adapter.read(`${path}/${snapshotId}.json`), snapshotId));
  }
}
