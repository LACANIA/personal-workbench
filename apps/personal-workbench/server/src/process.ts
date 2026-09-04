import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
}

export function runProcess(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; windowsHide?: boolean } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      // Most helpers are console-only. The native picker deliberately opts out so
      // its Windows Forms dialog is visible in the user's desktop session.
      windowsHide: options.windowsHide ?? true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { if (stdout.length < 2_000_000) stdout += String(chunk) })
    child.stderr.on('data', chunk => { if (stderr.length < 200_000) stderr += String(chunk) })
    child.once('error', error => {
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ stdout, stderr, exitCode, signal, timedOut, durationMs: performance.now() - started })
    })
    if (options.input !== undefined) child.stdin.end(options.input, 'utf8')
    else child.stdin.end()
  })
}
