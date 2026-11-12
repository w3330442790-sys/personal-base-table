import type { OutMsg } from "../../webview/src/host";
import type { BaseDoc } from "./types";
import * as ops from "./ops";
import { gridMeta, unmergeCells } from "./features";

export type SheetMessage = Exclude<OutMsg, { type: "ready" | "export" | "openLink" | "replaceAll" | "snapshotCreate" | "snapshotList" | "snapshotRead" }>;

export function applySheetMessage(sheet: BaseDoc, message: SheetMessage): void {
  switch (message.type) {
    case "updateCell": ops.updateCell(sheet, message.id, message.field, message.value); break;
    case "addRow": ops.addRow(sheet); break;
    case "deleteRow": ops.deleteRow(sheet, message.id); break;
    case "saveViews": ops.saveViews(sheet, message.views); break;
    case "setField": ops.setField(sheet, message.name, message.patch); break;
    case "renameField": {
      ops.renameField(sheet, message.oldName, message.newName);
      const meta = gridMeta(sheet);
      for (const rule of meta.rules ?? []) if (rule.field === message.oldName) rule.field = message.newName;
      for (const groups of Object.values(meta.columnGroupsByView ?? {})) for (const group of groups) group.fields = group.fields.map(field => field === message.oldName ? message.newName : field);
      for (const merge of meta.merges ?? []) {
        merge.fields = merge.fields.map(f => f === message.oldName ? message.newName : f);
        for (const values of Object.values(merge.original)) {
          if (message.oldName in values) { values[message.newName] = values[message.oldName]; delete values[message.oldName]; }
        }
      }
      if (meta.summary?.completionField === message.oldName) meta.summary.completionField = message.newName;
      if (meta.summary?.numberField === message.oldName) meta.summary.numberField = message.newName;
      break;
    }
    case "addField": ops.addField(sheet, message.name, message.def, message.after); break;
    case "duplicateField": ops.duplicateField(sheet, message.name); break;
    case "reorderFields": ops.reorderFields(sheet, message.names); break;
    case "moveRow": ops.moveRow(sheet, message.id, message.targetId); break;
    case "moveRowTo": ops.moveRowTo(sheet, message.id, message.targetId, message.before); break;
    case "deleteField": {
      const meta = gridMeta(sheet);
      for (const merge of [...meta.merges ?? []]) if (merge.fields.includes(message.name)) unmergeCells(sheet, merge.id);
      ops.deleteField(sheet, message.name);
      meta.rules = meta.rules?.filter(r => r.field !== message.name);
      for (const [view, groups] of Object.entries(meta.columnGroupsByView ?? {})) meta.columnGroupsByView![view] = groups.map(group => ({ ...group, fields: group.fields.filter(field => field !== message.name) })).filter(group => group.fields.length > 1);
      if (meta.summary?.completionField === message.name) delete meta.summary.completionField;
      if (meta.summary?.numberField === message.name) delete meta.summary.numberField;
      break;
    }
  }
}
