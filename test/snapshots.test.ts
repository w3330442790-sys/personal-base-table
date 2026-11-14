import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotAdapter, SnapshotStore } from "../src/core/snapshots";
import { BaseDoc } from "../src/core/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readDoc, replaceAll, snapshotAdapter } from "../src/vscode/fsStore";

class MemoryAdapter implements SnapshotAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  failWrite = false;
  corruptWrite = false;
  failRemove = false;
  removed: string[] = [];
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path: string) {
    if (this.dirs.has(path)) throw new Error("Already exists");
    this.dirs.add(path);
  }
  async read(path: string) {
    const data = this.files.get(path);
    if (data === undefined) throw new Error("Missing file");
    return data;
  }
  async write(path: string, data: string) {
    if (this.failWrite) throw new Error("Disk full");
    this.files.set(path, this.corruptWrite ? "{}" : data);
  }
  async remove(path: string) {
    if (this.failRemove) throw new Error("Delete denied");
    this.removed.push(path);
    this.files.delete(path);
  }
  async list(path: string) {
    return { files: [...this.files.keys()].filter(file => file.startsWith(path + "/")), folders: [] };
  }
}
const doc = (): BaseDoc => ({ fields: { 标题: { type: "text" } }, views: [], records: [{ id: "r1", 标题: "原值" }] });

test("snapshots persist independently, reload and follow a stable document id", async () => {
  const adapter = new MemoryAdapter();
  const store = new SnapshotStore(adapter);
  const source = doc();
  const snapshot = await store.create("document-1", "删除列前", source);
  source.records[0].标题 = "changed";
  const reloaded = new SnapshotStore(adapter);
  assert.deepEqual(await reloaded.list("document-1"), [snapshot]);
  assert.deepEqual((await reloaded.read("document-1", snapshot.id)).doc, doc());
  assert.equal((await reloaded.list("different-document")).length, 0);
});

test("snapshot pruning only follows a verified write and retries recover", async () => {
  const adapter = new MemoryAdapter();
  const store = new SnapshotStore(adapter, { maxCount: 1 });
  const first = await store.create("doc", "first", doc());
  adapter.failWrite = true;
  await assert.rejects(store.create("doc", "failed", doc()), /Disk full/);
  assert.equal(adapter.removed.length, 0);
  adapter.failWrite = false;
  adapter.corruptWrite = true;
  await assert.rejects(store.create("doc", "corrupted", doc()), /verif|Invalid/i);
  assert.deepEqual((await store.list("doc")).map(item => item.id), [first.id]);
  adapter.corruptWrite = false;
  const last = await store.create("doc", "last", doc());
  assert.deepEqual(await store.list("doc"), [last]);
});

test("count and UTF-8 byte limits preserve newest, oversize rejects before writing", async () => {
  const adapter = new MemoryAdapter();
  const initial = new SnapshotStore(adapter);
  await initial.create("doc", "first", doc());
  const size = new TextEncoder().encode([...adapter.files.values()][0]).length;
  const store = new SnapshotStore(adapter, { maxCount: 10, maxBytes: size + 10 });
  const latest = await store.create("doc", "second", doc());
  assert.deepEqual(await store.list("doc"), [latest]);
  const files = [...adapter.files];
  await assert.rejects(new SnapshotStore(adapter, { maxBytes: 1 }).create("doc", "large", doc()), /limit|large/i);
  assert.deepEqual([...adapter.files], files);
});

test("concurrent creates share serialization across stores and produce unique snapshots", async () => {
  const adapter = new MemoryAdapter();
  const one = new SnapshotStore(adapter, { maxCount: 2 });
  const two = new SnapshotStore(adapter, { maxCount: 2 });
  const snapshots = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? one : two).create("doc", String(i), doc())));
  assert.equal(new Set(snapshots.map(item => item.id)).size, 8);
  assert.deepEqual(await one.list("doc"), snapshots.slice(-2).reverse());
});

test("queued snapshots capture input immediately and pruning failures preserve verified data", async () => {
  const adapter = new MemoryAdapter();
  const store = new SnapshotStore(adapter, { maxCount: 1 });
  const input = doc();
  const pending = store.create("doc", "first", input);
  input.records[0].标题 = "edited while queued";
  const first = await pending;
  assert.deepEqual((await store.read("doc", first.id)).doc, doc());
  adapter.failRemove = true;
  await assert.rejects(store.create("doc", "second", doc()), /Delete denied/);
  assert.equal((await store.list("doc")).length, 2);
  assert.deepEqual((await store.read("doc", first.id)).doc, doc());
  adapter.failRemove = false;
  const last = await store.create("doc", "retry", doc());
  assert.deepEqual(await store.list("doc"), [last]);
});

test("untrusted adapter listings cannot read outside the document directory", async () => {
  const adapter = new MemoryAdapter();
  const store = new SnapshotStore(adapter);
  await store.create("doc", "first", doc());
  adapter.list = async () => ({ files: ["outside.json"], folders: [] });
  await assert.rejects(store.list("doc"), /Invalid snapshot path/);
  await assert.rejects(store.create("doc", "second", doc()), /Invalid snapshot path/);
  assert.equal(adapter.files.size, 1);
});

test("snapshot ids, document paths, adapter listings and saved data cannot escape history", async () => {
  const adapter = new MemoryAdapter();
  const store = new SnapshotStore(adapter);
  for (const id of ["../doc", "/doc", "C:\\doc", "a/../doc", ".personal-base-table-history/doc.wbase"]) {
    await assert.rejects(store.create(id, "bad", doc()), /Invalid/);
  }
  const legacy = await store.create("目录/旧文件.wbase", "legacy", doc());
  await assert.rejects(store.read("目录/旧文件.wbase", "../outside"), /Invalid/);
  const path = [...adapter.files.keys()][0];
  adapter.files.set(path, JSON.stringify({ ...legacy, doc: { fields: {}, records: [] } }));
  await assert.rejects(store.read("目录/旧文件.wbase", legacy.id), /Invalid/);
  assert.deepEqual(await store.list("目录/旧文件.wbase"), []);
});

test("a corrupt snapshot is quarantined instead of blocking valid history or new snapshots", async () => {
  const adapter = new MemoryAdapter();
  const store = new SnapshotStore(adapter, { maxCount: 2 });
  await store.create("doc", "first", doc());
  const path = [...adapter.files.keys()][0];
  adapter.files.set(path, "{broken");
  assert.deepEqual(await store.list("doc"), []);
  const second = await store.create("doc", "second", doc());
  assert.deepEqual(await store.list("doc"), [second]);
  assert.equal(adapter.files.has(path), true); // keep the bad file for manual recovery
  assert.deepEqual((await store.read("doc", second.id)).doc, doc());
});

test("filesystem history reloads and rejects traversal while document saves retain unknown metadata", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-store-"));
  try {
    const file = path.join(directory, "table.wbase");
    assert.throws(() => readDoc(file), /ENOENT/);
    fs.writeFileSync(file, "{invalid");
    assert.throws(() => readDoc(file), SyntaxError);
    const original = { ...doc(), customExtension: { keep: "原始扩展" } };
    replaceAll(file, original);
    assert.deepEqual(readDoc(file), original);
    const store = new SnapshotStore(snapshotAdapter(directory));
    const metadata = await store.create("stable-document", "disk", original);
    assert.deepEqual((await new SnapshotStore(snapshotAdapter(directory)).read("stable-document", metadata.id)).doc, original);
    await assert.rejects(snapshotAdapter(directory).read(".personal-base-table-history/../table.wbase"), /Invalid/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
