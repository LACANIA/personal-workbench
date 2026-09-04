# research-memory

`@local/research-memory` 是位于官方仓库之外的 Cordis 插件，只注册两个模型工具：

- `memory_query`：按关键词、实体类型和项目查询结构化记录，每类默认返回 20 条、最多 100 条，并可附带来源；
- `memory_get_project_context`：按项目读取六类业务实体，每类默认返回 20 条、最多 100 条，并可附带来源。

插件不会直接访问 SQLite。`client.js` 使用 Node `spawn()` 启动固定 Python 程序，并明确设置 `shell: false`；`read_only_bridge.py` 只调用 `agent_interface.query_memory()` 和 `agent_interface.get_project_context()`。Memory API 使用 SQLite URI `mode=ro` 并启用 `PRAGMA query_only`。

查询参数通过标准输入中的 JSON 传入，数据库路径、Python 可执行文件、桥接程序路径与超时由 Profile 配置。插件没有写入工具、网络客户端、Shell 工具或文件导入逻辑。

来源展开后，每条记录包含确定性的 `memory_citation`、`source_status` 和 `source_citations`。系统提示要求模型原样复制引用字段，禁止把一条记录的来源用于另一条记录；没有来源关联时需要明确说明来源尚未登记。
