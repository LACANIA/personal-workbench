# Document Chunk Search

本目录提供 Research Memory 的离线 FTS5 维护命令和只读 Chunk 查询 API。

离线管理命令：

```powershell
python memory/search/fts_rebuild.py --database <database-path>
python memory/search/fts_validate.py --database <database-path>
```

`fts_rebuild.py` 会先通过 SQLite backup API 生成备份并执行临时恢复验证，再重建派生索引、执行 FTS5 完整性检查并写入索引状态。`fts_validate.py` 校验来源数量、索引数量、确定性签名、SQLite 完整性和外键，不改变 Research Memory 业务记录。

只读 API 位于 `chunk_query.py`：

- `search_document_chunks()`：默认仅检索每个 Asset 的最新版本，使用 trigram FTS5；不足三个 Unicode 字符的查询采用数据库内受筛选的确定性子串扫描。
- `get_document_chunk()`：依据搜索结果返回的 64 位 `chunk_uid` 精确读取单个 Chunk。

STEP-13 的离线导入 API 仍位于 `memory.ingest.ingest_api`，没有被删除。Harness Bridge 只暴露查询操作，不允许迁移、重建或导入。
