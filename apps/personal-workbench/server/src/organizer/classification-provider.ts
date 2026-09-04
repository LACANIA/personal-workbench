import path from 'node:path'
import { PATHS } from '../config.ts'

export const ORGANIZER_CATEGORIES = ['学习资料', '工作资料', '个人文档', '图片', '视频', '音频', '压缩包', '安装包', '数据', '代码', '电子书', '票据证明', '截图', '临时文件', '待整理'] as const
export type OrganizerCategory = typeof ORGANIZER_CATEGORIES[number]
export type OrganizerCertainty = 'high' | 'medium' | 'low'
export interface OrganizerClassificationInput { file_key:string; relative_filename:string; file_type:string; parent_folder:string; title?:string; summary?:string; keywords?:string[] }
export interface OrganizerClassification { file_key:string; category:OrganizerCategory; topic:string|null; reason:string; certainty:OrganizerCertainty }

function safeTopic(value: unknown): string | null { if(typeof value!=='string')return null; const text=value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,60); return text.length>=2&&!text.includes('..')&&!path.isAbsolute(text)&&!text.startsWith('\\\\')?text:null }
export function validateOrganizerClassifications(value:unknown, allowed:Set<string>): OrganizerClassification[] {
  if(!Array.isArray(value))return []
  const output:OrganizerClassification[]=[]
  for(const item of value){ if(item===null||typeof item!=='object')continue; const row=item as Record<string,unknown>; const key=typeof row.file_key==='string'?row.file_key:''; const category=typeof row.category==='string'&&ORGANIZER_CATEGORIES.includes(row.category as OrganizerCategory)?row.category as OrganizerCategory:'待整理'; const certainty=['high','medium','low'].includes(String(row.certainty))?String(row.certainty) as OrganizerCertainty:'low'; const reason=typeof row.reason==='string'?row.reason.replace(/[\r\n]+/gu,' ').slice(0,240):''; if(!allowed.has(key)||reason.includes('..')||/[A-Za-z]:[\\/]|\\\\/u.test(reason))continue; output.push({file_key:key,category,topic:safeTopic(row.topic),reason:reason||'本机分类信息不足，建议由你确认。',certainty}) }
  return output
}

export function completeOrganizerClassifications(value:unknown, allowed:Set<string>): OrganizerClassification[] {
  const validated=validateOrganizerClassifications(value,allowed)
  const byKey=new Map(validated.map(item=>[item.file_key,item]))
  return [...allowed].map(file_key=>byKey.get(file_key)??({file_key,category:'待整理',topic:null,reason:'本机分类结果缺少该文件，默认保持原位并等待你确认。',certainty:'low'} as const))
}

/** Sends only bounded, relative profiles to the local Ollama endpoint. */
export class OrganizerBatchClassificationProvider {
  readonly endpoint=PATHS.ollamaEndpoint; readonly model='qwen3:8b'
  async classify(inputs:OrganizerClassificationInput[]):Promise<OrganizerClassification[]> {
    const batch=inputs.slice(0,20).map(item=>({...item,summary:item.summary?.slice(0,500),keywords:item.keywords?.slice(0,10)}))
    if(batch.length===0)return []
    const prompt=`你是本机文件整理助手。仅根据输入的相对文件名、类型、父目录和有限摘要，为每项选择一个 category：${ORGANIZER_CATEGORIES.join('、')}。topic 只能是简短目录名；不确定时 category 必须为“待整理”、certainty 为 low。不要输出绝对路径、命令、扩展名变更或解释外文本。只输出 JSON 数组，每项字段为 file_key,category,topic,reason,certainty。\n\n${JSON.stringify(batch)}`
    const allowed=new Set(batch.map(item=>item.file_key))
    try { const response=await fetch(new URL('/api/chat',`${this.endpoint}/`),{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(120_000),body:JSON.stringify({model:this.model,stream:false,think:false,format:'json',keep_alive:'2m',options:{temperature:0,seed:42,num_predict:800},messages:[{role:'user',content:prompt}]})}); if(!response.ok)return completeOrganizerClassifications([],allowed); const body=await response.json() as {message?:{content?:string}}; const parsed=JSON.parse(String(body.message?.content??'[]')) as unknown; return completeOrganizerClassifications(Array.isArray(parsed)?parsed:[parsed],allowed) } catch { return completeOrganizerClassifications([],allowed) }
  }
}
