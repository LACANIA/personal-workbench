import { useMemo, useState } from 'react'
import type { FirstRunSmokeResult, FirstRunStatus } from '../../../shared/contracts/index.ts'
import { api } from '../api/client.ts'
import { Badge, StatusDot } from './common.tsx'

const STEPS = ['系统检查', 'Ollama', '本地模型', '媒体组件', '数据位置', '完成'] as const

function statusText(status: FirstRunStatus): string {
  if (status.ollama?.status === 'running') return '已安装并运行'
  if (status.ollama?.status === 'installed_stopped') return '已安装，当前没有运行'
  return '未检测到'
}

export function FirstRunWizard({ status: initialStatus }: { status: FirstRunStatus }): JSX.Element | null {
  const [status, setStatus] = useState(initialStatus)
  const [step, setStep] = useState(0)
  const [completed, setCompleted] = useState(status.completed)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [smoke, setSmoke] = useState<FirstRunSmokeResult | null>(null)
  const models = status.models ?? []
  const requiredReady = models.filter(model => model.required).every(model => model.installed)
  const capabilityRows = useMemo(() => [
    ['本地AI', status.ollama?.status === 'running' && models.some(model => model.role === 'general' && model.installed)],
    ['文档学习', true], ['文件整理', true],
    ['本地检索', models.some(model => model.role === 'embedding' && model.installed)],
    ['视频学习', status.media_summary?.status !== 'not_installed'],
  ] as Array<[string, boolean]>, [status, models])
  if (!status.required || completed) return null

  const refresh = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try { setStatus(await api.firstRun()) } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const runSmoke = async (): Promise<void> => {
    setBusy(true); setMessage('正在验证本地模型…')
    try { const result = await api.firstRunSmoke(); setSmoke(result); setMessage(result.chat.ok && result.embedding.ok ? '本地模型验证完成。' : '有一项模型验证没有通过，可以稍后在系统状态中重试。') }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const installModel = async (model: string): Promise<void> => {
    if (!window.personalWorkbenchDesktop) { setMessage('请先安装Ollama，然后在Ollama中准备模型。'); return }
    setBusy(true); setMessage(`正在下载 ${model}，可以从Ollama查看网络活动。`)
    try { await window.personalWorkbenchDesktop.installModel(model); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }
  const complete = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try { await api.completeFirstRun({}); setCompleted(true) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  return <div className="first-run-overlay"><section className="first-run-card first-run-wizard">
    <Badge tone="blue">首次运行</Badge><h1>欢迎使用 Personal Workbench</h1>
    <ol className="first-run-steps">{STEPS.map((name, index) => <li key={name} className={index === step ? 'active' : index < step ? 'done' : ''}><span>{index + 1}</span>{name}</li>)}</ol>
    <div className="first-run-body">
      {step === 0 && <><h2>检查这台电脑</h2><div className="first-run-facts"><article><span>Windows</span><strong>{status.system?.windows ?? '正在读取'}</strong></article><article><span>处理器</span><strong>{status.system?.cpu ?? '正在读取'}</strong><small>{status.system?.logical_cores ?? '—'} 个逻辑核心</small></article><article><span>内存</span><strong>{status.system?.ram_gb ?? '—'} GB</strong></article><article><span>显卡</span><strong>{status.system?.gpu.name ?? '没有检测到NVIDIA显卡'}</strong><small>{status.system?.gpu.available ? `${status.system.gpu.vram_mb ?? '—'} MiB 显存` : '可以使用CPU运行，语音识别速度可能较慢。'}</small></article><article><span>可用空间</span><strong>{status.system?.disk_free_gb ?? '—'} GB</strong></article></div></>}
      {step === 1 && <><h2>连接本地AI</h2><div className="first-run-callout"><StatusDot status={status.ollama?.status === 'running' ? 'ok' : 'warning'} /><div><strong>{statusText(status)}</strong><p>Personal Workbench只连接本机Ollama，不会调整模型目录或删除已有模型。</p></div></div><div className="first-run-actions"><button onClick={() => void refresh()} disabled={busy}>重新检测</button>{status.ollama?.status === 'not_detected' && <button className="primary" onClick={() => void window.personalWorkbenchDesktop?.openExternal('https://ollama.com/download/windows')}>打开Ollama官方下载页面</button>}</div></>}
      {step === 2 && <><h2>准备本地模型</h2><div className="first-run-models">{models.map(model => <article key={model.id}><StatusDot status={model.installed ? 'ok' : 'warning'} /><div><strong>{model.id}</strong><small>{model.role === 'general' ? '通用学习与整理' : model.role === 'embedding' ? '文档本地检索' : '代码任务，可选'}</small></div><Badge tone={model.installed ? 'green' : 'amber'}>{model.installed ? '已安装' : model.required ? '需要准备' : '可选'}</Badge>{!model.installed && <button disabled={busy || status.ollama?.status !== 'running'} onClick={() => void installModel(model.id)}>安装模型</button>}</article>)}</div><div className="first-run-actions"><button onClick={() => void refresh()} disabled={busy}>重新检测</button><button className="primary" disabled={busy || !requiredReady} onClick={() => void runSmoke()}>验证模型</button></div>{smoke && <div className="smoke-result"><span>{smoke.chat.ok ? '✓' : '△'} 通用模型响应</span><span>{smoke.embedding.ok ? '✓' : '△'} 检索向量 {smoke.embedding.dimensions ?? '—'} 维</span></div>}</>}
      {step === 3 && <><h2>媒体组件</h2><p>这些组件用于视频学习、语音识别和扫描页文字识别，缺少时不会影响文件整理与普通文档处理。</p><div className="first-run-facts"><article><span>媒体读取</span><strong>{status.media_summary?.ffmpeg ? '可以使用' : '尚未安装'}</strong></article><article><span>视频下载</span><strong>{status.media_summary?.ytdlp ? '可以使用' : '尚未安装'}</strong></article><article><span>语音识别</span><strong>{status.media_summary?.asr ? status.media_summary.status === 'gpu' ? 'GPU可用' : 'CPU可用' : '尚未安装'}</strong></article><article><span>画面文字识别</span><strong>{status.media_summary?.ocr ? '可以使用' : '尚未安装'}</strong></article></div></>}
      {step === 4 && <><h2>数据保存位置</h2><div className="first-run-data"><strong>{status.data_root}</strong><p>数据库、学习资料、整理历史、配置和日志保存在当前用户的本机数据目录中。卸载应用时默认保留这些内容。</p></div></>}
      {step === 5 && <><h2>Personal Workbench 已准备完成</h2><div className="first-run-capabilities">{capabilityRows.map(([name, available]) => <span key={name}>{available ? '✓' : '△'} {name}{available ? '' : '需要设置'}</span>)}</div><p>可选组件以后可以从“设置 → 系统状态”继续配置。</p></>}
    </div>
    {message && <p className={message.includes('完成') || message.startsWith('正在') ? 'info-banner' : 'error-banner'}>{message}</p>}
    <footer className="first-run-footer"><button disabled={busy || step === 0} onClick={() => setStep(value => Math.max(0, value - 1))}>上一步</button><button className="primary" disabled={busy} onClick={() => step === STEPS.length - 1 ? void complete() : setStep(value => Math.min(STEPS.length - 1, value + 1))}>{step === STEPS.length - 1 ? '开始使用' : '下一步'}</button></footer>
  </section></div>
}
