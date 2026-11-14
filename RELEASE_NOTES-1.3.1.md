## 1.3.1 修复列头布局

1.3.0 的列头排序改动把 `th` 设成了 `display:flex`，导致表头脱离 `table-cell` 布局：德语、英语、词性、备注等字段竖排堆叠，表头与数据列错位。这是样式回归，**表格数据和 `.wbase` 文件内容没有损坏**。

### 修复

- `th` 保持 `table-cell` 布局，不再使用 flex。
- 列名和 `▾` 菜单放进 `th` 内部的 flex 容器，点击列名排序、点击 `▾` 打开字段菜单的交互保持不变。
- 表头恢复横向排列，并与数据列重新对齐。

### 验证

- `npm test`：**133 项通过，0 失败**。
- `npm run typecheck`、`npm run build:obsidian` 通过。
- 建议升级后重新打开一次表格；如果仍看到旧布局，请检查 BRAT 是否已切换到 1.3.1。

通过 BRAT 检查 `w3330442790-sys/personal-base-table` 更新即可安装；也可下载 `main.js`、`manifest.json`、`styles.css` 手动替换。
