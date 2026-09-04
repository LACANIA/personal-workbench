import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { SafeFsError, requireNonEmptyString } from './errors.js'

const DEFAULT_LIMITS = Object.freeze({
  readDefaultLines: 200,
  readMaxLines: 500,
  readMaxBytes: 2 * 1024 * 1024,
  globMaxPaths: 100,
  grepMaxMatches: 250,
  grepMaxFiles: 100,
  searchTimeoutMs: 15000,
})

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function parsePolicyText(text, policyPath) {
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch (error) {
    throw new SafeFsError('POLICY_INVALID', `${policyPath} must use JSON-compatible YAML syntax: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SafeFsError('POLICY_INVALID', `${policyPath} must contain an object`)
  }
  if (!Array.isArray(parsed.allowedRoots) || parsed.allowedRoots.length === 0) {
    throw new SafeFsError('POLICY_INVALID', 'allowedRoots must contain at least one path')
  }
  const limits = { ...DEFAULT_LIMITS, ...(parsed.limits ?? {}) }
  for (const [name, value] of Object.entries(limits)) {
    if (!isPositiveInteger(value)) {
      throw new SafeFsError('POLICY_INVALID', `limits.${name} must be a positive integer`)
    }
  }
  if (limits.globMaxPaths > 100) {
    throw new SafeFsError('POLICY_INVALID', 'limits.globMaxPaths cannot exceed 100')
  }
  if (limits.grepMaxMatches > 250) {
    throw new SafeFsError('POLICY_INVALID', 'limits.grepMaxMatches cannot exceed 250')
  }
  if (limits.grepMaxFiles > 100) {
    throw new SafeFsError('POLICY_INVALID', 'limits.grepMaxFiles cannot exceed 100')
  }
  if (limits.searchTimeoutMs > 15000) {
    throw new SafeFsError('POLICY_INVALID', 'limits.searchTimeoutMs cannot exceed 15000')
  }
  if (parsed.allowedFiles !== undefined && !Array.isArray(parsed.allowedFiles)) {
    throw new SafeFsError('POLICY_INVALID', 'allowedFiles must be an array when provided')
  }
  return { version: parsed.version ?? 1, allowedRoots: parsed.allowedRoots, allowedFiles: parsed.allowedFiles ?? [], limits }
}

function stripTrailingSeparators(value) {
  const root = path.parse(value).root
  let result = value
  while (result.length > root.length && /[\\/]$/u.test(result)) result = result.slice(0, -1)
  return result
}

function comparisonPath(value) {
  const normalized = stripTrailingSeparators(path.normalize(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function hasUnsafeNamespaceSyntax(value) {
  const windows = value.replaceAll('/', '\\')
  return windows.startsWith('\\\\')
    || /^\\\\[?.]\\/u.test(windows)
    || /^[A-Za-z]:[^\\/]/u.test(value)
}

function hasAlternateDataStreamSyntax(value) {
  const windows = value.replaceAll('/', '\\')
  const withoutDrive = /^[A-Za-z]:\\/u.test(windows) ? windows.slice(2) : windows
  return withoutDrive.includes(':')
}

function isWithinRoot(canonicalTarget, canonicalRoot) {
  const target = comparisonPath(canonicalTarget)
  const root = comparisonPath(canonicalRoot)
  if (target === root) return true
  return target.startsWith(`${root}${path.sep}`)
}

function pathPolicyDenied(input, reason) {
  throw new SafeFsError('PATH_POLICY_DENIED', `${JSON.stringify(input)} ${reason}`)
}

export class PathPolicy {
  constructor(policyPath, allowedRoots, allowedFiles, limits) {
    this.policyPath = policyPath
    this.allowedRoots = Object.freeze([...allowedRoots])
    this.allowedFiles = Object.freeze([...allowedFiles])
    this.limits = Object.freeze({ ...limits })
  }

  static async load(policyPath) {
    const absolutePolicyPath = path.resolve(requireNonEmptyString(policyPath, 'policyPath'))
    const document = parsePolicyText(await readFile(absolutePolicyPath, 'utf8'), absolutePolicyPath)
    const canonicalRoots = []
    for (const configuredRoot of document.allowedRoots) {
      const root = requireNonEmptyString(configuredRoot, 'allowedRoots entry')
      if (hasUnsafeNamespaceSyntax(root) || hasAlternateDataStreamSyntax(root)) {
        throw new SafeFsError('POLICY_INVALID', `unsupported allowed root syntax: ${JSON.stringify(root)}`)
      }
      const canonical = await realpath(path.resolve(root))
      const info = await stat(canonical)
      if (!info.isDirectory()) {
        throw new SafeFsError('POLICY_INVALID', `allowed root is not a directory: ${canonical}`)
      }
      if (!canonicalRoots.some(existing => comparisonPath(existing) === comparisonPath(canonical))) {
        canonicalRoots.push(stripTrailingSeparators(canonical))
      }
    }
    const canonicalFiles = []
    for (const configuredFile of document.allowedFiles) {
      const file = requireNonEmptyString(configuredFile, 'allowedFiles entry')
      if (hasUnsafeNamespaceSyntax(file) || hasAlternateDataStreamSyntax(file)) {
        throw new SafeFsError('POLICY_INVALID', `unsupported allowed file syntax: ${JSON.stringify(file)}`)
      }
      const canonical = await realpath(path.resolve(file))
      const info = await stat(canonical)
      if (!info.isFile()) throw new SafeFsError('POLICY_INVALID', `allowed file is not a regular file: ${canonical}`)
      if (!canonicalFiles.some(existing => comparisonPath(existing) === comparisonPath(canonical))) canonicalFiles.push(canonical)
    }
    return new PathPolicy(absolutePolicyPath, canonicalRoots, canonicalFiles, document.limits)
  }

  isAllowedCanonical(canonicalTarget) {
    return this.allowedRoots.some(root => isWithinRoot(canonicalTarget, root))
      || this.allowedFiles.some(file => comparisonPath(canonicalTarget) === comparisonPath(file))
  }

  assertAllowedCanonical(canonicalTarget, requestedPath = canonicalTarget) {
    if (!this.isAllowedCanonical(canonicalTarget)) {
      pathPolicyDenied(
        requestedPath,
        `resolves outside allowed paths; canonical path: ${canonicalTarget}; allowed roots: ${this.allowedRoots.join(', ')}; exact files: ${this.allowedFiles.join(', ')}`,
      )
    }
  }

  async resolveExisting(inputPath, baseDirectory, expectedType = 'any') {
    const input = requireNonEmptyString(inputPath, 'path')
    if (hasUnsafeNamespaceSyntax(input)) {
      pathPolicyDenied(input, 'uses a UNC or device namespace path')
    }
    if (hasAlternateDataStreamSyntax(input)) {
      pathPolicyDenied(input, 'uses alternate data stream syntax')
    }
    const base = requireNonEmptyString(baseDirectory, 'baseDirectory')
    const absolute = path.resolve(base, input)
    let canonical
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new SafeFsError('PATH_NOT_FOUND', `${JSON.stringify(input)} does not exist after normalization: ${absolute}`)
      }
      throw new SafeFsError('PATH_RESOLUTION_FAILED', `${JSON.stringify(input)} could not be resolved: ${error.message}`)
    }
    this.assertAllowedCanonical(canonical, input)
    const info = await stat(canonical)
    if (expectedType === 'file' && !info.isFile()) {
      throw new SafeFsError('PATH_TYPE_MISMATCH', `${canonical} is not a regular file`)
    }
    if (expectedType === 'directory' && !info.isDirectory()) {
      throw new SafeFsError('PATH_TYPE_MISMATCH', `${canonical} is not a directory`)
    }
    return { requestedPath: input, absolutePath: absolute, canonicalPath: canonical, info }
  }
}

export { DEFAULT_LIMITS, comparisonPath, isWithinRoot, parsePolicyText }
