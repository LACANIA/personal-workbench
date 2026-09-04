import { describe, expect, it } from 'vitest'
import { modelIsAllowed, validateExternalUrl } from '../../desktop/runtime.mjs'

describe('desktop model boundary', () => {
  it('allows only the three documented local model roles', () => {
    expect(modelIsAllowed('qwen3:8b')).toBe(true)
    expect(modelIsAllowed('qwen3-embedding:0.6b')).toBe(true)
    expect(modelIsAllowed('qwen2.5-coder:7b')).toBe(true)
    expect(modelIsAllowed('unknown:latest')).toBe(false)
  })

  it('opens only explicit HTTPS external pages', () => {
    expect(validateExternalUrl('https://ollama.com/download/windows')).toMatch(/^https:/u)
    expect(() => validateExternalUrl('file:///C:/Windows/System32')).toThrow('EXTERNAL_URL_DENIED')
  })
})
