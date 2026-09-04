interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

function compactText(value: string, maximum = 4000): string {
  if (value.length <= maximum) return value
  return `${value.slice(0, Math.max(0, maximum - 180))}\n…[已省略 ${value.length - maximum} 个字符]…`
}

function redactToolValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (key === 'content') return `[正文未写入 Workbench 任务库；原始字符数 ${value.length}]`
    if (key === 'snippet') return compactText(value, 1200)
    return compactText(value, 2000)
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactToolValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([itemKey, itemValue]) => [itemKey, redactToolValue(itemValue, itemKey)]))
  }
  return value
}

function redactToolText(value: string): string {
  try { return JSON.stringify(redactToolValue(JSON.parse(value) as unknown)) } catch {
    return value.length <= 800 ? value : `[工具正文未写入 Workbench 任务库；原始字符数 ${value.length}]`
  }
}

export function sanitizeHarnessNotification(notification: HarnessNotification): HarnessNotification {
  const event = notification.params.event as { type?: unknown } | undefined
  const toolResult = event?.type === 'tool/result'
  const visit = (value: unknown, key = ''): unknown => {
    if (/(?:replayState|credential|environment|apiKey)/iu.test(key)) return '[已隐藏]'
    if (typeof value === 'string') {
      if (toolResult && key === 'text') return redactToolText(value)
      return compactText(value)
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(item => visit(item))
    if (value !== null && typeof value === 'object') {
      const item = value as Record<string, unknown>
      if (item.type === 'reasoning' && typeof item.text === 'string') return { ...item, text: '[推理过程未写入 Workbench 任务库]' }
      return Object.fromEntries(Object.entries(item).map(([itemKey, itemValue]) => [itemKey, visit(itemValue, itemKey)]))
    }
    return value
  }
  return visit(notification) as HarnessNotification
}

export function shouldPersistHarnessNotification(notification: HarnessNotification): boolean {
  const event = notification.params.event as { type?: unknown } | undefined
  return event?.type !== 'assistant/chunk'
}
