# 受控单文件导入

STEP-13 的导入层只处理调用方明确指定的一个 `.md`、`.markdown` 或 `.txt` 文件。模块不扫描目录，不调用模型，不生成事实摘要，也不向 Harness 暴露写入工具。

## 执行流程

默认命令进入 `preview`，读取路径策略、校验 UTF-8 文本、计算原始字节哈希与规范文本哈希、解析 Markdown 行结构、生成确定性 Chunk，并把有限预览写入审核 Manifest。该阶段以只读方式连接 SQLite，不创建 Source、Document、Asset、Version、Chunk 或 Ingest Run。

```powershell
python document_ingest.py `
  --database ..\tests\test_research_memory.db `
  --project STAKG-SP `
  --file C:\research\approved-report.md `
  --source-version STEP-10 `
  --summary "Research Memory STEP-10 foundation report"
```

审核 Manifest 后，提交命令必须同时传入文件路径和准确的 SHA-256：

```powershell
python document_ingest.py commit `
  --manifest <manifest-path> `
  --manifest-sha256 <sha256>
```

提交阶段会重新读取文件并复算全部 Chunk，确认结果与 Manifest 相同，随后通过 `sqlite3.Connection.backup()` 创建数据库备份并执行临时恢复校验。正式写入使用单个 SQLite 事务，失败时回滚。生产库提交还要求 `--confirm-production-write`；STEP-13 没有使用该参数。

## 文件与路径边界

路径策略默认来自仓库的 `config/personal-path-policy.example.yaml`，也可以通过 `PERSONAL_PATH_POLICY_PATH` 指向本机受控配置。程序拒绝白名单外目标、路径穿越、越界 Junction 或符号链接、UNC、设备路径、NTFS Alternate Data Stream、目录、不受支持的扩展名、无效 UTF-8、NUL 字节、二进制内容和超过 5 MiB 的文件。

## 分块与重放

默认 Chunk 上限为 120 行和 8000 字符，优先在 Heading 或空行边界切分，并尽量避免在 fenced code block 内切分。每一行恰好属于一个 Chunk。Chunk UID 由原始文件哈希、起止行、Chunk 内容哈希共同计算，相同输入与配置会得到相同结果。

## API 边界

`ingest_api.py` 提供预览、提交、Asset/Version/Chunk 查询与确定性文本匹配。这些接口只供离线脚本和测试使用。`read_only_bridge.py` 继续只允许 `query_memory` 和 `get_project_context`，Cordis 插件继续只注册两个 Memory 查询工具。
