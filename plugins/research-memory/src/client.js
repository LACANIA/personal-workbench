import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const MAX_BRIDGE_OUTPUT_BYTES = 4 * 1024 * 1024

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function requireTimeout(value) {
  if (!Number.isInteger(value) || value < 100 || value > 120000) {
    throw new TypeError('timeoutMs must be an integer from 100 to 120000')
  }
  return value
}

async function requireFile(filePath, name) {
  const info = await stat(filePath)
  if (!info.isFile()) throw new TypeError(`${name} must reference a file: ${filePath}`)
}

export class MemoryClientError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MemoryClientError'
    this.code = code
  }
}

export class ResearchMemoryClient {
  constructor({ pythonExecutable, bridgePath, databasePath, timeoutMs }) {
    this.pythonExecutable = requireNonEmptyString(pythonExecutable, 'pythonExecutable')
    this.bridgePath = requireNonEmptyString(bridgePath, 'bridgePath')
    this.databasePath = requireNonEmptyString(databasePath, 'databasePath')
    this.timeoutMs = requireTimeout(timeoutMs)
  }

  static async create(config) {
    const client = new ResearchMemoryClient(config)
    await Promise.all([
      requireFile(client.pythonExecutable, 'pythonExecutable'),
      requireFile(client.bridgePath, 'bridgePath'),
      requireFile(client.databasePath, 'databasePath'),
    ])
    return client
  }

  async invoke(operation, argumentsValue, signal) {
    if (signal?.aborted) {
      throw new MemoryClientError('MEMORY_QUERY_ABORTED', 'Research Memory query was aborted')
    }

    const payload = JSON.stringify({ operation, ...argumentsValue })
    const startedAt = performance.now()
    const response = await new Promise((resolve, reject) => {
      const child = spawn(
        this.pythonExecutable,
        [this.bridgePath, '--database', this.databasePath],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONNOUSERSITE: '1',
          },
        },
      )

      const stdout = []
      const stderr = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false

      const finish = (handler, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', abort)
        handler(value)
      }

      const stopWithError = error => {
        child.kill()
        finish(reject, error)
      }

      const abort = () => {
        stopWithError(new MemoryClientError('MEMORY_QUERY_ABORTED', 'Research Memory query was aborted'))
      }

      const timer = setTimeout(() => {
        stopWithError(new MemoryClientError('MEMORY_QUERY_TIMEOUT', `Research Memory query exceeded ${this.timeoutMs} ms`))
      }, this.timeoutMs)

      if (signal !== undefined) signal.addEventListener('abort', abort, { once: true })

      child.once('error', error => {
        finish(reject, new MemoryClientError('MEMORY_BRIDGE_START_FAILED', error.message))
      })
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_BRIDGE_OUTPUT_BYTES) {
          stopWithError(new MemoryClientError('MEMORY_BRIDGE_OUTPUT_LIMIT', 'Research Memory bridge output exceeded 4 MiB'))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length
        if (stderrBytes > MAX_BRIDGE_OUTPUT_BYTES) {
          stopWithError(new MemoryClientError('MEMORY_BRIDGE_OUTPUT_LIMIT', 'Research Memory bridge error output exceeded 4 MiB'))
          return
        }
        stderr.push(chunk)
      })
      child.once('close', code => {
        if (settled) return
        const errorText = Buffer.concat(stderr).toString('utf8').trim()
        if (code !== 0) {
          finish(reject, new MemoryClientError('MEMORY_BRIDGE_EXIT', `Research Memory bridge exited with ${code}: ${errorText}`))
          return
        }
        const outputText = Buffer.concat(stdout).toString('utf8').trim()
        let parsed
        try {
          parsed = JSON.parse(outputText)
        } catch (error) {
          finish(reject, new MemoryClientError('MEMORY_BRIDGE_PROTOCOL', `Invalid bridge JSON: ${error.message}`))
          return
        }
        if (parsed?.ok !== true) {
          const codeValue = parsed?.error?.code ?? 'MEMORY_BRIDGE_ERROR'
          const message = parsed?.error?.message ?? 'Research Memory bridge returned an unknown error'
          finish(reject, new MemoryClientError(codeValue, message))
          return
        }
        finish(resolve, parsed)
      })
      child.stdin.on('error', error => {
        if (error.code !== 'EPIPE') {
          stopWithError(new MemoryClientError('MEMORY_BRIDGE_INPUT', error.message))
        }
      })
      child.stdin.end(payload, 'utf8')
    })

    return {
      response,
      metrics: {
        sqliteQueryMs: response.duration_ms,
        clientTotalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      },
    }
  }

  async queryMemory(argumentsValue, signal) {
    const options = typeof argumentsValue === 'string' ? { query: argumentsValue } : argumentsValue
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('query arguments must be an object')
    }
    const payload = { ...options, query: requireNonEmptyString(options.query, 'query') }
    const { response, metrics } = await this.invoke('query_memory', payload, signal)
    return {
      value: {
        status: 'OK',
        query: response.result.query,
        matches: response.result.records,
        count: response.result.match_count,
        applied_filters: response.result.applied_filters,
        truncated: response.result.truncated,
        truncated_by_type: response.result.truncated_by_type,
        counts: response.result.counts,
        returned_counts: response.result.returned_counts,
      },
      metrics,
    }
  }

  async getProjectContext(argumentsValue, signal) {
    const options = typeof argumentsValue === 'string'
      ? { project_name: argumentsValue }
      : argumentsValue
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('project context arguments must be an object')
    }
    const payload = {
      ...options,
      project_name: requireNonEmptyString(options.project_name, 'project_name'),
    }
    const { response, metrics } = await this.invoke(
      'get_project_context',
      payload,
      signal,
    )
    return { value: response.result, metrics }
  }

  async searchDocumentChunks(argumentsValue, signal) {
    if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      throw new TypeError('Document Chunk search arguments must be an object')
    }
    const payload = {
      ...argumentsValue,
      query: requireNonEmptyString(argumentsValue.query, 'query'),
    }
    const { response, metrics } = await this.invoke(
      'search_document_chunks',
      payload,
      signal,
    )
    return { value: response.result, metrics }
  }

  async getDocumentChunk(argumentsValue, signal) {
    if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
      throw new TypeError('Document Chunk arguments must be an object')
    }
    const payload = {
      ...argumentsValue,
      chunk_uid: requireNonEmptyString(argumentsValue.chunk_uid, 'chunk_uid'),
    }
    const { response, metrics } = await this.invoke(
      'get_document_chunk',
      payload,
      signal,
    )
    return { value: response.result, metrics }
  }
}
