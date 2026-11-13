# 我的多维表格 · Personal Base Table

Obsidian 个人多维表格插件，基于 [Weilanx Base Table](https://github.com/Azure12355/weilanx-base-table) 开发，兼容原有 `.wbase` 表格。

## 使用 BRAT 安装

1. 在每台设备的 Obsidian 中安装并启用 BRAT。
2. 打开 BRAT 设置，选择 **Add beta plugin**。
3. 输入 `w3330442790-sys/personal-base-table`，选择最新版本并安装。
4. 关闭原来的 **Weilanx Base Table**，启用 **我的多维表格**。
5. 打开已有 `.wbase` 文件即可使用。后续版本可以通过 BRAT 检查更新。

插件支持桌面与移动端安装。当前版本已经完成 Windows 桌面验收，手机端尚未实机验证。

BRAT 负责插件安装和更新，表格文件需要通过自己的 Obsidian 库同步方式同步到其他设备。

## 功能

- Excel 式底部工作表标签，每张表独立保存字段、记录和视图。
- 行号列紧凑并支持拖动调宽，字段和选区操作面板跟随点击位置。
- 查找等工具使用可拖动的右上角悬浮窗，单元格支持直接输入、F2 编辑、Enter/Tab 换格和 Esc 取消。
- 选区右键设置增粗、斜体、下划线、删除线和对齐，格式随工作簿保存，并支持撤销、复制和导出。
- 查找替换，支持单列、选区、当前表和整个工作簿。
- 行插入、复制、批量填充、清空与跨表移动。
- 多级父子行、按后续 N 行建立归属、折叠和叶子行汇总。
- 区域复制粘贴与预览，支持 Excel/WPS 多行多列内容。
- 合并与取消合并单元格，保留原值供恢复。
- 条件格式、行详情、图片和附件预览。
- 表格与父子行模板，历史快照、差异预览及恢复。
- 文件级撤销与重做，覆盖整列删除等结构操作。
- 保留原有筛选、排序、分组、多视图、字段设置与导出能力。

## 数据兼容与恢复

主表继续使用原来的 `fields`、`views` 和 `records`。附加工作表位于 `personal`，层级、合并和显示设置位于 `personalGrid`。新增功能使用后，请继续通过个人版编辑，以完整保存这些扩展信息。

历史快照位于库内 `.personal-base-table-history`。默认每文件保留 30 份，容量上限 100 MB，可在插件设置修改。保存失败时可重试或导出待保存副本。

## 手动安装

从 [Releases](https://github.com/w3330442790-sys/personal-base-table/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`，放入库内 `.obsidian/plugins/personal-base-table`，再启用插件。

## 当前边界

- 拖动填充向下扩展，序列模式按数字加一或日期递增一天。
- 合并区域需要取消合并后再执行查找替换。涉及纵向合并的排序会提示先拆分。
- 历史差异每张表显示前 100 项，并显示全部差异数量。
- CSV 导出普通单元格，Excel HTML `.xls` 支持合并区域，JSON 导出完整工作簿。

## 开发

```sh
npm ci
npm test
npm run typecheck
npm run build:obsidian
```

安装文件输出到 `dist/obsidian`。详细操作见 [使用说明](README.personal.zh-CN.md)。

## 上游与许可证

本项目由 `w3330442790-sys` 维护，基于 Azure12355 的 Weilanx Base Table 0.18.0。上游 MIT 许可证和作者归属保留于 [LICENSE](LICENSE)。原项目说明保留于 [README.upstream.md](README.upstream.md) 和 [README.upstream.zh-CN.md](README.upstream.zh-CN.md)。
