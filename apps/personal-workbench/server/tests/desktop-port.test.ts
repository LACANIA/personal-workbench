import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

describe('desktop dynamic port', () => {
  it('lets Windows select an available loopback port', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    expect(typeof address).toBe('object')
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1')
    expect(typeof address === 'object' && Number(address?.port)).toBeGreaterThan(0)
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
