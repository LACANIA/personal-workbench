import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireNonEmptyString } from './errors.js'
import { personalGlob, personalGrep, personalRead, displayGlobResult, displayGrepResult, displayReadResult } from './operations.js'
import { PathPolicy } from './policy.js'

export const name = 'personal-safe-fs'
export const inject = ['tools', 'systemPrompt']

const readOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    canonicalFilePath: { type: 'string', required: true },
    startLine: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true },
    totalLines: { type: 'integer', required: true },
    content: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
  },
}

const globOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    canonicalSearchRoot: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    totalObserved: { type: 'integer', required: true },
    returnedCount: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    paths: { type: 'array', required: true, items: { type: 'string' } },
    guidance: { type: 'string', required: true },
  },
}

const grepOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    canonicalSearchPath: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    totalObserved: { type: 'integer', required: true },
    returnedMatchCount: { type: 'integer', required: true },
    returnedFileCount: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    timedOut: { type: 'boolean', required: true },
    matches: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          lineNumber: { type: 'integer', required: true },
          line: { type: 'string', required: true },
        },
      },
    },
    guidance: { type: 'string', required: true },
  },
}

export async function apply(ctx, config = {}) {
  const policyPath = requireNonEmptyString(config.policyPath, 'policyPath')
  const policy = await PathPolicy.load(policyPath)

  ctx.systemPrompt.section({
    name: 'tool:personal-safe-fs',
    order: 100,
    text: 'Use only personal_read, personal_glob, and personal_grep for file analysis. Every path is checked against an explicit local allowlist. Cite canonical file paths and line numbers from tool results. Narrow searches when a result reports TOO_BROAD or TRUNCATED. This profile has no file writing capability.',
  })

  ctx.tools.register(defineTool({
    name: 'personal_read',
    description: `Read a bounded UTF-8 text window from an allowed file. Returns a canonical path and line range. Maximum ${policy.limits.readMaxLines} lines per call.`,
    parameters: {
      file_path: { type: 'string', required: true, description: 'Relative or absolute file path. The canonical target must be inside an allowed root.' },
      offset: { type: 'number', description: '1-based first line. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum lines to return. Defaults to ${policy.limits.readDefaultLines}; cap ${policy.limits.readMaxLines}.` },
    },
    output: {
      schema: readOutputSchema,
      render: (_args, value) => [{ type: 'text', text: displayReadResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return personalRead(policy, args, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_glob',
    description: `Find files under an explicit allowed directory using a glob pattern. Returns at most ${policy.limits.globMaxPaths} canonical paths and reports truncation.`,
    parameters: {
      path: { type: 'string', required: true, description: 'Explicit directory to search. The canonical directory must be inside an allowed root.' },
      pattern: { type: 'string', required: true, description: 'Glob pattern such as apps/*/package.json or **/*.md.' },
    },
    timeoutMs: policy.limits.searchTimeoutMs,
    output: {
      schema: globOutputSchema,
      render: (_args, value) => [{ type: 'text', text: displayGlobResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return personalGlob(policy, args, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'personal_grep',
    description: `Search UTF-8 file content under an explicit allowed path. Returns canonical paths and line numbers, up to ${policy.limits.grepMaxMatches} matches across ${policy.limits.grepMaxFiles} files.`,
    parameters: {
      path: { type: 'string', required: true, description: 'Explicit file or directory to search. The canonical target must be inside an allowed root.' },
      pattern: { type: 'string', required: true, description: 'Ripgrep regular expression.' },
      include: { type: 'string', description: 'Optional single glob filter such as *.ts or **/*.md.' },
    },
    timeoutMs: policy.limits.searchTimeoutMs,
    output: {
      schema: grepOutputSchema,
      render: (_args, value) => [{ type: 'text', text: displayGrepResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return personalGrep(policy, args, exec)
    },
  }))
}
