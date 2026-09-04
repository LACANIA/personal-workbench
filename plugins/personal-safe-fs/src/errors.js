export class SafeFsError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'SafeFsError'
    this.code = code
  }
}

export function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SafeFsError('INVALID_ARGUMENT', `${name} must be a non-empty string`)
  }
  if (value.includes('\0')) {
    throw new SafeFsError('INVALID_ARGUMENT', `${name} contains a NUL character`)
  }
  return value.trim()
}

export function requirePositiveInteger(value, name, defaultValue, maximum) {
  const resolved = value === undefined ? defaultValue : value
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new SafeFsError('INVALID_ARGUMENT', `${name} must be an integer from 1 through ${maximum}`)
  }
  return resolved
}
