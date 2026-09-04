import { open } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { SafeFsError, requireNonEmptyString, requirePositiveInteger } from './errors.js'
import { resolveRipgrepPath, runRipgrepLines } from './process.js'

function sessionBase(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function displayReadResult(value) {
  const body = value.content.length === 0
    ? '(no lines in requested window)'
    : value.content.split('\n').map((line, index) => `${value.startLine + index}: ${line}`).join('\n')
  return [
    `status: ${value.status}`,
    `canonical_file_path: ${value.canonicalFilePath}`,
    `line_range: ${value.startLine}-${value.endLine}`,
    `total_lines: ${value.totalLines}`,
    `truncated: ${value.truncated}`,
    'content:',
    body,
  ].join('\n')
}

function displayGlobResult(value) {
  return [
    `status: ${value.status}`,
    `canonical_search_root: ${value.canonicalSearchRoot}`,
    `pattern: ${value.pattern}`,
    `total_observed: ${value.totalObserved}`,
    `returned_count: ${value.returnedCount}`,
    `truncated: ${value.truncated}`,
    ...(value.guidance.length > 0 ? [`guidance: ${value.guidance}`] : []),
    'paths:',
    ...(value.paths.length > 0 ? value.paths : ['(none)']),
  ].join('\n')
}

function displayGrepResult(value) {
  const rows = value.matches.map(match => `${match.path}:${match.lineNumber}: ${match.line}`)
  return [
    `status: ${value.status}`,
    `canonical_search_path: ${value.canonicalSearchPath}`,
    `pattern: ${value.pattern}`,
    `total_observed: ${value.totalObserved}`,
    `returned_matches: ${value.returnedMatchCount}`,
    `returned_files: ${value.returnedFileCount}`,
    `truncated: ${value.truncated}`,
    `timed_out: ${value.timedOut}`,
    ...(value.guidance.length > 0 ? [`guidance: ${value.guidance}`] : []),
    'matches:',
    ...(rows.length > 0 ? rows : ['(none)']),
  ].join('\n')
}

export async function personalRead(policy, args, exec) {
  const offset = requirePositiveInteger(args.offset, 'offset', 1, Number.MAX_SAFE_INTEGER)
  const limit = requirePositiveInteger(args.limit, 'limit', policy.limits.readDefaultLines, policy.limits.readMaxLines)
  const target = await policy.resolveExisting(args.file_path, sessionBase(exec), 'file')
  const handle = await open(target.canonicalPath, 'r')
  let bytes
  try {
    const openedInfo = await handle.stat()
    if (openedInfo.dev !== target.info.dev || openedInfo.ino !== target.info.ino) {
      throw new SafeFsError('PATH_CHANGED_DURING_ACCESS', `${target.canonicalPath} changed after canonical-path validation`)
    }
    if (!openedInfo.isFile()) {
      throw new SafeFsError('PATH_TYPE_MISMATCH', `${target.canonicalPath} is not a regular file`)
    }
    if (openedInfo.size > policy.limits.readMaxBytes) {
      throw new SafeFsError('FILE_TOO_LARGE', `${target.canonicalPath} is ${openedInfo.size} bytes; limit is ${policy.limits.readMaxBytes}`)
    }
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (bytes.length > policy.limits.readMaxBytes) {
    throw new SafeFsError('FILE_TOO_LARGE', `${target.canonicalPath} grew beyond the ${policy.limits.readMaxBytes}-byte limit while reading`)
  }
  if (bytes.includes(0)) {
    throw new SafeFsError('BINARY_FILE_DENIED', `${target.canonicalPath} contains NUL bytes`)
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SafeFsError('TEXT_ENCODING_DENIED', `${target.canonicalPath} is not valid UTF-8 text`)
  }
  const lines = text.length === 0 ? [] : text.split(/\r\n|\n|\r/u)
  if (lines.length > 0 && lines.at(-1) === '' && /(?:\r\n|\n|\r)$/u.test(text)) lines.pop()
  const selected = lines.slice(offset - 1, offset - 1 + limit)
  const endLine = selected.length === 0 ? Math.max(0, offset - 1) : offset + selected.length - 1
  return {
    status: 'OK',
    canonicalFilePath: target.canonicalPath,
    startLine: offset,
    endLine,
    totalLines: lines.length,
    content: selected.join('\n'),
    truncated: offset > 1 || endLine < lines.length,
  }
}

export async function personalGlob(policy, args, exec) {
  const pattern = requireNonEmptyString(args.pattern, 'pattern')
  const root = await policy.resolveExisting(args.path, sessionBase(exec), 'directory')
  const rgPath = await resolveRipgrepPath()
  const observed = []
  let totalObserved = 0
  let capped = false
  const internalTimeout = Math.max(1, Math.min(policy.limits.searchTimeoutMs - 250, 14750))
  const run = await runRipgrepLines({
    executable: rgPath,
    args: ['--files', '--hidden', '--no-ignore', '--glob', '!.git/**', '--glob', pattern, '.'],
    cwd: root.canonicalPath,
    timeoutMs: internalTimeout,
    signal: exec?.signal,
    onLine(line) {
      totalObserved += 1
      if (observed.length < policy.limits.globMaxPaths) observed.push(line)
      if (totalObserved > policy.limits.globMaxPaths) {
        capped = true
        return false
      }
      return true
    },
  })
  const paths = []
  let skippedDenied = 0
  for (const item of observed) {
    try {
      const candidate = await policy.resolveExisting(path.resolve(root.canonicalPath, item), root.canonicalPath, 'file')
      paths.push(candidate.canonicalPath)
    } catch (error) {
      if (error?.code === 'PATH_POLICY_DENIED' || error?.code === 'PATH_NOT_FOUND') skippedDenied += 1
      else throw error
    }
  }
  const truncated = capped || run.timedOut || skippedDenied > 0
  return {
    status: run.timedOut ? 'TOO_BROAD' : truncated ? 'TRUNCATED' : 'OK',
    canonicalSearchRoot: root.canonicalPath,
    pattern,
    totalObserved,
    returnedCount: paths.length,
    truncated,
    paths,
    guidance: truncated ? 'Narrow path or pattern and retry; unsafe canonical targets are omitted.' : '',
  }
}

function grepEvent(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch (error) {
    throw new SafeFsError('SEARCH_PROTOCOL_ERROR', `invalid ripgrep JSON: ${error.message}`)
  }
  if (event.type !== 'match') return undefined
  const data = event.data
  if (typeof data?.path?.text !== 'string' || typeof data?.lines?.text !== 'string' || !Number.isInteger(data.line_number)) {
    return undefined
  }
  return { path: data.path.text, lineNumber: data.line_number, line: data.lines.text.replace(/[\r\n]+$/u, '') }
}

export async function personalGrep(policy, args, exec) {
  const pattern = requireNonEmptyString(args.pattern, 'pattern')
  const include = args.include === undefined ? undefined : requireNonEmptyString(args.include, 'include')
  const target = await policy.resolveExisting(args.path, sessionBase(exec), 'any')
  const cwd = target.info.isDirectory() ? target.canonicalPath : path.dirname(target.canonicalPath)
  const searchArg = target.info.isDirectory() ? '.' : path.basename(target.canonicalPath)
  const rgPath = await resolveRipgrepPath()
  const observed = []
  const observedFiles = new Set()
  let totalObserved = 0
  let capped = false
  const argv = ['--json', '--hidden', '--no-ignore', '--glob', '!.git/**']
  if (include !== undefined) argv.push('--glob', include)
  argv.push('--', pattern, searchArg)
  const internalTimeout = Math.max(1, Math.min(policy.limits.searchTimeoutMs - 250, 14750))
  const run = await runRipgrepLines({
    executable: rgPath,
    args: argv,
    cwd,
    timeoutMs: internalTimeout,
    signal: exec?.signal,
    onLine(line) {
      const match = grepEvent(line)
      if (match === undefined) return true
      totalObserved += 1
      observedFiles.add(comparisonKey(path.resolve(cwd, match.path)))
      if (observed.length < policy.limits.grepMaxMatches && observedFiles.size <= policy.limits.grepMaxFiles) {
        observed.push(match)
      }
      if (totalObserved > policy.limits.grepMaxMatches || observedFiles.size > policy.limits.grepMaxFiles) {
        capped = true
        return false
      }
      return true
    },
  })
  const matches = []
  const returnedFiles = new Set()
  let skippedDenied = 0
  for (const match of observed) {
    try {
      const candidate = await policy.resolveExisting(path.resolve(cwd, match.path), cwd, 'file')
      const fileKey = comparisonKey(candidate.canonicalPath)
      if (!returnedFiles.has(fileKey) && returnedFiles.size >= policy.limits.grepMaxFiles) {
        capped = true
        break
      }
      returnedFiles.add(fileKey)
      matches.push({
        path: candidate.canonicalPath,
        lineNumber: match.lineNumber,
        line: match.line.length > 1000 ? `${match.line.slice(0, 1000)}…` : match.line,
      })
    } catch (error) {
      if (error?.code === 'PATH_POLICY_DENIED' || error?.code === 'PATH_NOT_FOUND') skippedDenied += 1
      else throw error
    }
  }
  const truncated = capped || run.timedOut || skippedDenied > 0
  const status = run.timedOut || (capped && include === undefined) ? 'TOO_BROAD' : truncated ? 'TRUNCATED' : 'OK'
  return {
    status,
    canonicalSearchPath: target.canonicalPath,
    pattern,
    totalObserved,
    returnedMatchCount: matches.length,
    returnedFileCount: returnedFiles.size,
    truncated,
    timedOut: run.timedOut,
    matches,
    guidance: truncated ? 'Narrow path, include, or pattern and retry; unsafe canonical targets are omitted.' : '',
  }
}

function comparisonKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export { displayGlobResult, displayGrepResult, displayReadResult, sessionBase }
