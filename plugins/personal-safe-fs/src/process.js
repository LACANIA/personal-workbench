import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { SafeFsError } from './errors.js'

export async function resolveRipgrepPath() {
  try {
    const module = await import('@vscode/ripgrep')
    return module.rgPath
  } catch (error) {
    throw new SafeFsError('SEARCH_BACKEND_UNAVAILABLE', `packaged ripgrep could not be loaded: ${error.message}`)
  }
}

export function runRipgrepLines({ executable, args, cwd, timeoutMs, signal, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--no-config', ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
    })
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let pending = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let stoppedByConsumer = false
    let lineError
    let settled = false

    const terminate = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const abort = () => {
      aborted = true
      terminate()
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })

    const acceptLine = (line) => {
      if (line.length === 0 || stoppedByConsumer) return
      try {
        if (onLine(line) === false) {
          stoppedByConsumer = true
          terminate()
        }
      } catch (error) {
        lineError = error
        terminate()
      }
    }

    child.stdout.on('data', chunk => {
      pending += stdoutDecoder.write(chunk)
      for (;;) {
        const index = pending.indexOf('\n')
        if (index < 0) break
        const line = pending.slice(0, index).replace(/\r$/u, '')
        pending = pending.slice(index + 1)
        acceptLine(line)
      }
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 16384) stderr += stderrDecoder.write(chunk)
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new SafeFsError('SEARCH_FAILED', error.message))
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      pending += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      if (pending.length > 0 && !stoppedByConsumer) acceptLine(pending.replace(/\r$/u, ''))
      if (lineError !== undefined) {
        reject(lineError)
        return
      }
      if (aborted && !timedOut) {
        reject(new SafeFsError('SEARCH_ABORTED', 'search was cancelled'))
        return
      }
      if (!timedOut && !stoppedByConsumer && code !== 0 && code !== 1) {
        reject(new SafeFsError('SEARCH_FAILED', `ripgrep exited with code ${code}: ${stderr.trim().slice(-2000)}`))
        return
      }
      resolve({ code, timedOut, stoppedByConsumer, stderr: stderr.trim() })
    })
  })
}
