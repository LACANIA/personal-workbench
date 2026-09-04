# Research Memory 基础层

## 作用范围

Research Memory 为个人科研项目保存可复查的结构化记录。v3 延续项目、决策、实验、文档元数据、任务和会话六类实体及其来源关系，并增加逻辑文档、内容版本、行号分块和正式导入记录。代码位于 `my-agent`，没有修改 Harness 的 Agent Loop、模型适配层或 Session 数据。

生产数据库位于 `memory/database/research_memory.db`。测试使用 `memory/tests/test_research_memory.db`，两者都受到数据库路径校验约束，数据库文件只能位于 `memory` 目录内部。

## 第一阶段采用 SQLite 的原因

当前数据以项目关联、时间顺序和精确字段查询为主，SQLite 可以提供事务、外键、唯一约束、索引和单文件备份，并且 Python 标准库已经包含驱动。向量检索需要额外的文本切分、Embedding 模型、版本标识和重建策略；这些条件尚未进入本阶段，所以先建立可审计的结构化数据层，减少早期数据迁移成本。

## Schema 设计

| 实体 | 表名 | 主要关联 | 用途 |
| --- | --- | --- | --- |
| Project | `projects` | 根实体 | 长期项目及项目根路径 |
| Decision | `decisions` | `project_id` | 决策、原因、证据和置信度 |
| Experiment | `experiments` | `project_id` | 实验配置、结果、指标和产物路径 |
| Document | `documents` | `project_id` | 文件元数据、摘要和哈希 |
| Task | `tasks` | `project_id` | Agent 或人工任务状态 |
| Session | `sessions` | `task_id` | 模型、工具、结果与任务的关联 |
| Source | `sources` | 可选 `project_id` | 文件、报告、论文、会话或外部引用的元数据 |
| Record Source | `record_sources` | `source_id` 与多态实体定位 | 记录与来源之间的多对多关系、行页定位和验证状态 |
| Schema Migration | `schema_migrations` | Schema 版本 | 已应用迁移的名称、SQL 校验值和时间 |
| Document Asset | `document_assets` | `project_id` | 同一项目中的逻辑文档与规范路径 |
| Document Version | `document_versions` | Asset、Document、Source | 文件哈希、解析器、分块配置和内容版本 |
| Document Chunk | `document_chunks` | `document_version_id` | 带行号、Heading Path 和内容哈希的派生文本 |
| Ingest Run | `ingest_runs` | Project、Asset、Version | 正式提交或重复导入的审计记录 |

所有时间由 API 写为带 `Z` 后缀的 UTC ISO 8601 字符串。SQLite 数据库编码为 UTF-8，关联字段启用外键约束。`config`、`result`、`evidence` 和 `tools` 接受普通文本或可 JSON 序列化的数据，API 查询时会还原 JSON 对象与数组。

## 初始化与测试

新数据库从仓库的 `memory/database` 目录执行：

```powershell
python init_db.py
```

现有 v1 数据库先创建备份，再执行迁移：

```powershell
python backup_db.py ..\database\research_memory.db --label production-pre-migration
python migrate_db.py ..\database\research_memory.db --backup-manifest <manifest-path>
python validate_db.py ..\database\research_memory.db
python verify_backup.py <manifest-path>
```

迁移程序只接受已知版本，检查 SQL SHA-256，在单个事务中应用迁移，完成后运行 `integrity_check` 和 `foreign_key_check`。重复执行已经登记的迁移不会再次应用 SQL。

从仓库根目录执行内置测试：

```powershell
python -m unittest discover -s memory/tests -p "test*.py" -v
```

项目不依赖第三方 Python 包。初始化脚本会输出数据库路径、表清单、UTF-8 编码、Schema 版本和 `integrity_check` 结果。

## API 使用示例

```python
from memory.api import create_project, get_project_context

project = create_project(
    name="STAKG-SP",
    description="LEO Doppler positioning and satellite knowledge graph project",
    root_path=r"C:\research\STAKG-SP",
    status="active",
)

context = get_project_context("STAKG-SP")
```

`memory_api.py` 提供实体级增查函数，以及 `add_source()`、`get_source()`、`query_sources()`、`link_record_source()` 和 `get_record_sources()`。`query_memory()` 支持实体筛选、项目筛选、每类返回上限与来源展开；`get_project_context()` 支持每类上限与来源展开。两项查询的默认上限为 20，最大值为 100。

## Harness 只读接入

`my-agent/plugins/research-memory` 通过 Python Bridge 暴露 `memory_query` 与 `memory_get_project_context`。Bridge 仅允许这两个操作，数据库连接使用 `mode=ro` 和 `PRAGMA query_only=ON`。`personal-research` 指向生产库，`personal-research-test` 指向测试库；写入 API 仅供离线管理脚本与测试代码调用。

## 受控文档导入

`memory/ingest/document_ingest.py` 默认执行 dry-run，只接受调用方明确指定的单个 Markdown 或 UTF-8 文本文件。Dry-run 生成有限预览 Manifest，不修改数据库。正式提交要求审核后的 Manifest 和准确 SHA-256，并在事务前创建及验证备份。详细命令和路径边界见 `memory/ingest/README.md`。

Document Chunk 当前只供离线 API 查询，没有进入 `read_only_bridge.py`，也没有成为 Harness Tool。生产数据库仅完成 Schema v3 迁移，STEP-13 没有向其中导入业务文档。

## 后续增加 Embedding

增加语义检索前，需要在现有文档版本和分块之上补充 Embedding 模型标识、向量维度、生成时间和来源范围。向量索引可以作为结构化数据库之外的派生数据，Project、Document 和 Experiment 的主记录继续以 SQLite 为准。更新源文档时根据哈希重新生成受影响的分块，避免全量重建。

## 形成 Research Agent 的路线

Research Agent 可以先通过 `get_project_context()` 取得 Project、Decision、Experiment、Document、Task 和 Session，再根据用户问题调用 `query_memory()` 缩小记录范围。需要记录新结论时，Agent 通过经过审批的离线流程写入明确实体。目录扫描、内容摘要和 Embedding 需要在后续独立阶段设计，不能隐式扫描计算机或用户个人目录。

## 安全边界

本模块只写入当前源码树的 `memory` 数据区域。导入程序读取调用方明确给出的单个文件，路径必须通过个人目录白名单。模块不扫描目录，不访问 Harness Session，也不调用网络、云端 API、向量数据库或 Embedding 服务。
