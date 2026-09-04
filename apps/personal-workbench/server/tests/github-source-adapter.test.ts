import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubSourceAdapter, GITHUB_CLONE_FIXED_ARGS, githubCloneArgs, normalizeGithubRepositoryUrl } from '../src/sources/github-source-adapter.ts'
import type { ProcessResult } from '../src/process.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function result(stdout = '', exitCode = 0): ProcessResult { return { stdout, stderr: '', exitCode, signal: null, timedOut: false, durationMs: 1 } }

describe('STEP-34 GitHubSourceAdapter', () => {
  it('normalizes repository URLs and keeps clone arguments fixed and shell-free', () => {
    expect(normalizeGithubRepositoryUrl('https://github.com/example/demo.git')).toMatchObject({ canonical: 'https://github.com/example/demo', kind: 'repository' })
    expect(normalizeGithubRepositoryUrl('https://github.com/example/demo/issues/12').kind).toBe('issue')
    expect(githubCloneArgs('https://github.com/example/demo', 'E:/runtime/repo')).toEqual([...GITHUB_CLONE_FIXED_ARGS, 'https://github.com/example/demo', 'E:/runtime/repo'])
    expect(GITHUB_CLONE_FIXED_ARGS).not.toContain('--upload-pack')
  })

  it('reads only selected repository text, skips ignored and binary files, and records the commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'step34-github-'))
    roots.push(root)
    const execute = async (_exe: string, args: readonly string[]): Promise<ProcessResult> => {
      if (args[0] === 'clone') {
        const repo = String(args.at(-1))
        await mkdir(path.join(repo, 'src'), { recursive: true })
        await mkdir(path.join(repo, 'node_modules', 'ignored'), { recursive: true })
        await writeFile(path.join(repo, 'README'), '# Demo\n\n这个项目用于演示受控仓库分析。\n', 'utf8')
        await writeFile(path.join(repo, 'package.json'), '{"name":"demo","scripts":{"start":"node src/index.js"}}', 'utf8')
        await writeFile(path.join(repo, 'src', 'index.js'), 'export const greet = name => `hello ${name}`\n', 'utf8')
        await writeFile(path.join(repo, 'node_modules', 'ignored', 'package.js'), 'do not scan', 'utf8')
        await writeFile(path.join(repo, 'model.bin'), Buffer.from([0, 1, 2]))
        return result()
      }
      if (args.includes('rev-parse')) return result('0123456789abcdef0123456789abcdef01234567\n')
      if (args.includes('branch')) return result('main\n')
      return result()
    }
    const adapter = new GitHubSourceAdapter(execute, root, () => 'C:\\fixed\\git.exe', async () => undefined)
    const document = await adapter.acquire({ source_type: 'github_repo', source_reference: 'https://github.com/example/demo', display_name: 'example/demo', metadata: { github_kind: 'repository', user_instruction: '重点说明目录和安装方式' } }, { taskId: 'task-1', projectId: 'project-1', report: () => undefined })
    expect(document.metadata).toMatchObject({ repository_commit: '0123456789abcdef0123456789abcdef01234567', branch: 'main', file_count: expect.any(Number) })
    expect(document.content).toContain('README')
    expect(document.content).toContain('src/index.js')
    expect(document.content).not.toContain('node_modules/ignored')
    expect(document.content).toContain('model.bin（二进制，仅登记）')
    expect(document.code_blocks.some(block => block.source_anchor === 'model.bin')).toBe(false)
    expect(document.code_blocks.some(block => block.source_anchor === 'src/index.js')).toBe(true)
    expect(document.metadata.selected_files).toEqual(expect.arrayContaining([expect.objectContaining({ repo_relative_path: 'README', selected_reason: expect.any(String) })]))
  })
})
