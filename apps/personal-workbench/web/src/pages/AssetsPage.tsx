import { useState } from 'react'
import type { DatabaseRole, WorkbenchTask } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import type { AppSnapshot } from '../app/types.ts'
import { Badge, EmptyState, formatBytes, Metric, Panel } from '../components/common.tsx'

export function AssetsPage({ snapshot, databaseRole, onOpenTask }: { snapshot: AppSnapshot; databaseRole: DatabaseRole; onOpenTask(id: string): void }): JSX.Element {
  const [pathValue, setPathValue] = useState(snapshot.localConfig?.project_path ?? snapshot.workspaces.allowedRoots[0] ?? '')
  const [task, setTask] = useState<WorkbenchTask | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inventory = task?.metadata.inventory as Record<string, unknown> | undefined
  const run = async () => {
    setBusy(true); setError('')
    try {
      const created = await api.createTask({ templateId: 'asset-inventory', inputType: 'directory', inputValue: pathValue, workspacePath: pathValue, databaseRole })
      await api.startTask(created.id)
      let current = created
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 200))
        current = (await api.task(created.id)).task
        if (['completed', 'failed'].includes(current.status)) break
      }
      setTask(current)
    } catch (caught) { setError(String(caught)) }
    finally { setBusy(false) }
  }
  return <div className="page-stack">
    <header className="page-heading"><div><Badge tone="blue">项目与资产</Badge><h1>查看明确目录中的项目资料</h1><p>统计仅覆盖用户指定目录，缓存、环境目录和链接目标会被跳过。</p></div></header>
    <div className="dashboard-grid">
      <Panel title="Research Memory 项目" subtitle={`当前为${databaseRole === 'test' ? '测试' : '正式'}数据`}>
        {snapshot.projects.length === 0 ? <EmptyState icon="◇" title="正式库尚无项目" detail="开发模式可以查看测试项目。" /> : <div className="project-list">{snapshot.projects.map(project => <article key={String(project.id)}><div><strong>{String(project.name)}</strong><p>{String(project.description ?? '无描述')}</p></div><Badge tone="green">{String(project.status)}</Badge></article>)}</div>}
      </Panel>
      <Panel title="路径许可范围" subtitle="目录统计与文件任务均经过路径核验"><ul className="root-list">{snapshot.workspaces.allowedRoots.map(root => <li key={root}><span>允许根</span><code>{root}</code></li>)}</ul></Panel>
    </div>
    <Panel title="资产清单" subtitle="文件数量、目录数量和容量由控制服务直接计算，不调用模型。">
      <div className="search-bar"><input value={pathValue} onChange={event => setPathValue(event.target.value)} /><button className="primary" disabled={busy} onClick={() => void run()}>{busy ? '正在统计…' : '开始统计'}</button></div>
      {error && <p className="error-banner">{error}</p>}
      {inventory && <><div className="metric-grid"><Metric label="文件" value={String(inventory.fileCount)} /><Metric label="目录" value={String(inventory.directoryCount)} /><Metric label="总容量" value={formatBytes(Number(inventory.totalBytes))} /><Metric label="扫描耗时" value={`${Number(inventory.durationMs).toFixed(1)} ms`} /></div><div className="inventory-grid"><div><h3>扩展名分布</h3>{(inventory.extensionDistribution as { extension: string; count: number }[]).slice(0, 10).map(item => <div className="bar-row" key={item.extension}><span>{item.extension}</span><i style={{ width: `${Math.min(100, item.count * 4)}%` }} /><strong>{item.count}</strong></div>)}</div><div><h3>最近修改</h3><ul className="file-list">{(inventory.recentFiles as { path: string; modifiedAt: string }[]).slice(0, 6).map(item => <li key={item.path}><code>{item.path}</code><span>{new Date(item.modifiedAt).toLocaleString()}</span></li>)}</ul></div></div><button className="text-button" onClick={() => task && onOpenTask(task.id)}>打开完整任务记录 →</button></>}
    </Panel>
  </div>
}
