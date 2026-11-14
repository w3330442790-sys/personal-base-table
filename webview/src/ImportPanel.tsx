import { useMemo, useState } from "react";
import type { BaseDoc } from "../../src/core/types";
import { buildImportedDoc, importSheetName, parseImportText } from "./import";

interface Props {
  onClose: () => void;
  onImportTable: (doc: BaseDoc, name: string) => void;
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (value === true) return "是";
  if (value === false) return "否";
  return String(value);
}

export function ImportPanel({ onClose, onImportTable }: Props) {
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [header, setHeader] = useState(true);
  const [error, setError] = useState("");

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { ...parseImportText(text), error: "" };
    } catch (reason) {
      return { matrix: [] as string[][], delimiter: "", error: (reason as Error).message };
    }
  }, [text]);

  const preview = useMemo<BaseDoc | null>(() => {
    if (!parsed?.matrix.length) return null;
    try {
      return buildImportedDoc(parsed.matrix, { header });
    } catch {
      return null;
    }
  }, [parsed, header]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setFileName(file.name);
    try {
      setText(await file.text());
    } catch (reason) {
      setError(`读取文件失败：${(reason as Error).message}`);
    }
  };

  const doImport = () => {
    setError("");
    if (!preview) { setError("没有可导入的数据"); return; }
    try {
      onImportTable(preview, importSheetName(fileName || "导入表格"));
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const rows = preview?.records.slice(0, 5) ?? [];
  const columns = preview ? Object.keys(preview.fields) : [];
  return <div className="import-panel">
    <p className="feature-muted">读取 CSV / TSV 文件，或直接粘贴表格文本；导入后会新建一张工作表。</p>
    <label className="feature-inline import-file">
      <span>选择文件</span>
      <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={event => { void readFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    </label>
    <label>或粘贴内容
      <textarea aria-label="导入表格内容" rows={6} value={text} onChange={event => setText(event.target.value)} placeholder={"标题,状态,日期\n示例,待办,2026-01-01"} />
    </label>
    <label className="feature-inline"><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} />首行是字段名</label>
    {parsed?.delimiter && <p className="feature-muted">识别分隔符：{parsed.delimiter === "\t" ? "Tab" : parsed.delimiter} · 有效行 {parsed.matrix.length}</p>}
    {parsed?.error && <p className="feature-error" role="alert">{parsed.error}</p>}
    {error && <p className="feature-error" role="alert">{error}</p>}
    {preview && <section className="import-preview" aria-label="导入预览">
      <p>将新建「{importSheetName(fileName || "导入表格")}」：{columns.length} 个字段，{preview.records.length} 条记录</p>
      <div className="import-preview-scroll"><table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}<small>{preview.fields[column].type}</small></th>)}</tr></thead>
        <tbody>{rows.map((record) => <tr key={String(record.id)}>{columns.map((column) => <td key={column}>{cellText(record[column])}</td>)}</tr>)}</tbody>
      </table></div>
      {preview.records.length > rows.length && <p className="feature-muted">仅预览前 {rows.length} 条。</p>}
    </section>}
    <div className="feature-actions">
      <button type="button" className="btn primary" disabled={!preview} onClick={doImport}>导入为新工作表</button>
      <button type="button" className="btn" onClick={onClose}>取消</button>
    </div>
  </div>;
}
