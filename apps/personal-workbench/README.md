# Personal Workbench

Personal Workbench 是运行于本机的资料、项目、任务、Research Memory 与文档证据工作台。界面采用 React、TypeScript 和 Vite；控制服务采用 Node.js、TypeScript 与 Node 内置 SQLite。服务仅绑定 `127.0.0.1`，每次启动生成随机会话令牌。

## 启动

双击：

`launchers\启动 Personal Workbench.cmd`

桌面也提供 `Personal Workbench.exe`。该图形启动器调用同一套 PowerShell 启动检查，启动期间显示进度窗口，失败时显示提示并将诊断信息写入 `data\logs\desktop-launcher.log`。可审计源码与可重复构建脚本分别位于 `launchers\PersonalWorkbenchLauncher.cs` 和 `launchers\build-personal-workbench-launcher.ps1`。

启动器会检查 Node.js、pnpm 和 Ollama，注入固定的只读环境，检查前端构建，启动控制服务，等待健康检查通过，然后打开默认浏览器。重复启动会复用现有服务。

PowerShell 启动脚本保存为带 BOM 的 UTF-8，确保 Windows PowerShell 5.1 可以正确解析中文错误信息。CMD 入口继续调用系统自带 `powershell.exe`。

## 内部任务通道

模型任务采用 DeepSeek Harness 官方 TypeScript SDK。控制服务通过临时 Patch 关闭一次性 Headless Runner，加载官方 SDK JSON-RPC Server，并保留所选用户 Profile 的模型与工具配置。SDK 返回真实 Session ID、Session 事件、最终回答和状态通知。CLI 只作为诊断后备。

任务模板只能选择内部白名单中的 Profile：

- `file-analysis` → `personal-safe-readonly`
- `project-summary`、`memory-query`、`document-chunk-search` → 正式模式使用 `personal-research`，开发模式使用 `personal-research-test`
- `asset-inventory` → 控制服务确定性统计，不调用模型
- `video-to-knowledge` → 本机 Video Knowledge 流水线；字幕文件可以直接处理，网址与无字幕视频依据可选媒体适配器状态启用

## Portable Distribution

`local-config.json` 使用版本化 Portable Config，路径从应用所在目录、环境变量和当前用户的 Ollama 默认安装目录探测。配置支持独立的 Harness、DSH_HOME、Research Memory、备份目录、Ollama、FFmpeg、ffprobe、yt-dlp、ASR Python 与本地 ASR 模型路径。首次运行向导显示必需组件与可选媒体组件，确认后写入本机配置。

设置页面可以创建 Workbench 与正式 Research Memory 的 SQLite 在线备份。每份备份附带 SHA-256、完整性检查和外键检查。`pnpm run release` 生成 Windows x64 源码发行包及文件清单；包中不会包含模型、媒体、云端密钥、会话或运行数据库。

## Video Knowledge Agent

视频页面支持字幕文件、本地视频和视频网址。字幕文件经过 UTF-8 解析、时间轴切片、本机向量、确定性知识点提取与知识关系生成，然后创建转录文本、知识包和关系图 Artifact。检索层使用独立的 Embedding Provider；专用模型可用时调用本机 Ollama `/api/embed`，不可用时回退到 256 维 Unicode n-gram SHA-256 向量。回退界面明确标记为“基础本地检索模式”。

本地视频优先读取同名 `.srt`、`.vtt` 或 `.txt` 侧挂字幕；未提供侧挂字幕时，只有 Portable Config 已配置本机 faster-whisper Python 和本地模型才会启动 ASR。网址输入只通过受控 yt-dlp 参数数组处理，不读取浏览器 Cookie，也不保存带查询参数的网址。可选适配器缺失时任务返回明确诊断。

视频知识先写入 Workbench 的 `video_documents`、`video_segments`、`video_knowledge_points` 与 `video_knowledge_edges`，状态为 `staged`。知识包进入 Artifact、Evidence、版本、Audit、Knowledge Policy 和人工审核流程。只有 Release Gate 返回 `READY` 且项目已经显式绑定 Research Memory Project 时，用户才能执行发布。发布记录位于 Workbench Video Memory 扩展表，Research Memory 原有 Schema 与只读 Bridge 保持原样。

## Semantic Embedding Retrieval

`EmbeddingProvider` 将业务逻辑与具体向量模型分离，当前实现包括 `ollama_embedding` 和 `local_hash_v1`。正式向量以 Float32 BLOB 写入 Workbench 的 `embedding_records`；同一 Video Segment 或 Knowledge Point 可以同时保存多个 Provider 和模型版本，正文 SHA-256 发生变化时旧向量保留并标记为非活动记录。Research Memory 数据库与 Schema 不参与该存储。

`POST /api/video/search` 支持语义检索与基础本地检索、项目范围、实体类型和 `top_k`。结果包含 Video Document、Segment、Knowledge Point、时间范围、Transcript Source、Artifact 与 Evidence 摘要。未审核知识使用 `staged` 索引状态，Embedding 成功不会触发发布。设置页面提供 Retrieval Runtime 诊断、固定 Benchmark 摘要和显式索引入口。

固定 Benchmark 使用预先冻结的语料与 Ground Truth，对 local-hash-v1 和专用 Embedding 计算 Recall@1/3/5、MRR@5、nDCG@5、Citation Hit Rate 与查询延迟。只有质量、引用和本机运行条件全部满足配置判定时，专用模型才会成为默认检索方式。

## 数据边界

- Workbench 任务数据库：`data\personal-workbench.db`
- Research Memory 保持只读；正式库与测试库继续分离
- 模型端点固定为 `http://127.0.0.1:11434/v1`
- 文件任务继续使用 `personal-path-policy.yaml`
- 控制服务不提供任意命令、任意 Profile、Research Memory 写入或云端接口；媒体进程只使用 Portable Config 中的固定可执行文件与参数数组

## Project Context

“项目”页面可以登记用户通过目录选择器明确授权的目录，并保存项目名称、规范根路径、说明、识别类型、扫描时间和资产统计。项目扫描复用确定性 Asset Inventory，只保存文件数量、目录数量、容量、扩展名分布、最近修改路径和大文件路径，不保存文件正文。

Workbench 任务表包含服务端计算的 `project_id`。新任务的文件路径或工作区属于已登记根目录时自动关联；前端不能提交原始 `project_id`。Project Context 与 Research Memory 使用独立数据库，Memory 关系只在 Workbench 中保存引用元数据。

Project Intelligence 使用连续资产快照生成聚合变化摘要，并将项目创建、扫描完成、任务完成和 Memory 引用组合为项目时间线。变化分析只比较文件数、容量和扩展名集合，不执行逐文件差异比较。结构化推荐操作可以创建资产清单任务、重新扫描项目或创建项目状态报告任务。

## Artifact Context

Workbench 使用独立的 `artifacts` 表登记项目和任务产物。索引保存规范路径、相对路径、类型、MIME、大小、SHA-256、创建时间和元数据，不保存文件正文。Artifact 注册会同时执行路径许可与项目根目录检查；移除接口只删除 Workbench 索引，磁盘文件不会变化。

任务完成后只检查任务工作区内固定的 `output` 和 `outputs` 目录，候选扩展名限定为 `.md`、`.txt`、`.json`、`.csv`、`.xlsx`、`.png` 和 `.jpg`。候选结果先写入任务的候选索引，用户在任务详情中确认后才创建正式 Artifact 记录。

## Artifact Intelligence

Artifact Intelligence 在现有索引上增加预览、健康状态和版本关系。文本、代码、JSON 与 CSV 预览最多读取 100 KiB；PNG 与 JPEG 只返回尺寸和 MIME 元数据。预览过程不缓存文件正文，也不会执行代码。未知二进制格式会被拒绝。

Artifact 状态包括 `active`、`missing`、`outdated` 和 `archived`。健康检查重新确认文件存在性并计算当前 SHA-256：文件消失时标记为 `missing`，内容哈希变化时标记为 `outdated`，哈希一致时标记为 `active`。归档状态由用户显式操作，健康检查不会自动取消归档。

`artifact_versions` 保存同一成果链中的版本编号、哈希、大小和变更说明；`artifact_version_links` 使用 `supersedes` 表达新成果替代旧成果。版本记录只建立关系，不复制原始文件。任务详情中的“保存回答为报告”会在任务工作区的 `output` 目录创建一个新的 Markdown 候选，仍需用户确认后才登记为 Artifact，并且文件采用唯一名称，不会覆盖已有报告。

“打开文件位置”只接收已登记 Artifact ID，服务端重新验证数据库路径、项目边界和路径策略，然后以固定的 `explorer.exe` 参数数组打开所在目录。前端不能提交任意命令或任意系统路径。

## Artifact Evidence Linking

`artifact_evidence_links` 只保存 Artifact 与 Task、Harness Session、Research Memory、Document Chunk、Source 或其他 Artifact 之间的关系元数据。记录包含来源类型、来源标识、关系类型和可选标识元数据，不复制 Memory 记录、Chunk 正文或用户文件。

用户确认任务报告候选时，当前 Task 会默认建立 `generated_from` 关系，已存在的 Harness Session 会默认建立 `created_by` 关系。Memory、Source 和 Document Chunk 在建立关系前使用 Research Memory 只读连接核验；Document Chunk 关系仅记录 `chunk_id`、`document_id`和 `version_id`。移除 Evidence 只删除关系记录，Artifact 与来源对象不会变化。

## Provenance Graph 与 Evidence Audit

`ProvenanceGraphService` 根据 `artifact_evidence_links` 即时生成 Artifact 中心来源图，节点类型包括 Artifact、Task、Session、Memory、Document Chunk 和 Source。SVG 界面直接使用图 API 的节点与关系，不引入图数据库，也不复制来源正文。

`EvidenceAuditService` 检查 Evidence 是否存在、来源能否读取、同项目约束、Artifact 状态和版本关系。审计结果分为 `healthy`、`warning` 和 `broken`，执行过的 Artifact 审计写入 `provenance_audit_records`，项目时间线据此显示 `audit_completed` 事件。Provenance Manifest 仅导出 Artifact 标识、SHA-256 和关系标识。

## Evidence Intelligence Dashboard

项目详情中的 Evidence Intelligence 页面使用 `EvidenceHealthService` 即时汇总 Artifact 数量、Evidence Coverage、`healthy`、`warning`、`broken` 和 Issue Center。计算过程只读取现有 Artifact、Evidence、版本与 Audit 数据，不创建健康状态缓存，也不修改来源对象。

`ReleaseAuditService` 检查 Evidence、Audit、版本快照、来源可用性和最新人工审核。结构检查通过且最新审核为 `approved` 时返回 `READY`；最新审核为 `rejected` 时返回 `REJECTED`；其余情况返回 `NEEDS_REVIEW`。Artifact Provenance API 支持 `depth=1`、`depth=2` 和 `depth=3`；遍历只沿同一项目内的 Artifact 关系继续展开，并使用已访问集合阻止循环。

## Evidence Review Queue

“审核队列”页面聚合当前项目中 `warning`、`broken`、Evidence 缺失和尚未人工批准的 Artifact。`review_decisions` 以追加记录方式保存 `pending`、`approved`、`rejected` 或 `needs_revision`，同时保存审核人、备注和时间。提交审核不会更新 Artifact、Evidence、Research Memory 或 Document Chunk，也不会自动批准或发布。

项目 Evidence Intelligence 页面显示 Review Overview，Artifact 详情提供 Review 标签和完整审核历史。发布判定始终读取最新人工记录，旧记录继续保留，便于查看判断变化。

本机 API：

- `GET /api/projects/context`
- `GET /api/projects/:id`
- `POST /api/projects/register`
- `POST /api/projects/:id/scan`
- `GET /api/projects/:id/history`
- `GET /api/projects/:id/timeline`
- `POST /api/projects/:id/memory-link`
- `DELETE /api/projects/:id/memory-link`
- `GET /api/artifacts`
- `GET /api/projects/:id/artifacts`
- `GET /api/tasks/:id/artifacts`
- `POST /api/artifacts/register`
- `GET /api/artifacts/:id/preview`
- `POST /api/artifacts/:id/check`
- `GET /api/artifacts/:id/history`
- `POST /api/artifacts/:id/open-location`
- `POST /api/artifacts/:id/status`
- `GET /api/artifacts/:id/evidence`
- `POST /api/artifacts/:id/evidence`
- `GET /api/artifacts/:id/provenance?depth=1|2|3`
- `POST /api/artifacts/:id/audit`
- `GET /api/artifacts/:id/provenance/export`
- `GET /api/projects/:id/provenance`
- `GET /api/projects/:id/audit`
- `GET /api/projects/:id/evidence-health`
- `GET /api/projects/:id/reviews`
- `GET /api/projects/:id/review-summary`
- `POST /api/artifacts/:id/review`
- `GET /api/artifacts/:id/reviews/history`
- `DELETE /api/artifacts/:id`
- `GET /api/evidence/source/:type/:id`
- `DELETE /api/evidence/:id`
- `POST /api/tasks/:id/save-report`
- `POST /api/video/search`
- `GET /api/retrieval/diagnostics`
- `POST /api/retrieval/index`
- `GET /api/media/temp`
- `POST /api/media/temp/cleanup`

## 开发命令

```powershell
pnpm install
pnpm run build
pnpm test
pnpm start
```
