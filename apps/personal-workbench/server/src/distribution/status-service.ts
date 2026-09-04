import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DistributionStatus } from '../../../shared/contracts/index.ts'
import { PATHS } from '../config.ts'
import { MediaToolService } from '../video/media-tools.ts'
import { BackupManager } from './backup-manager.ts'
import { FirstRunService } from './first-run-service.ts'

async function hash(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', value => digest.update(value))
    stream.once('error', reject); stream.once('end', resolve)
  })
  return digest.digest('hex')
}

export class DistributionStatusService {
  constructor(readonly backups: BackupManager, readonly firstRun: FirstRunService, readonly media = new MediaToolService()) {}

  async status(): Promise<DistributionStatus> {
    const backupRows = await this.backups.list()
    let releasePath: string | null = null
    if (existsSync(PATHS.releases)) {
      const entries = (await readdir(PATHS.releases)).filter(name => name.toLowerCase().endsWith('.zip')).sort().reverse()
      if (entries.length > 0) releasePath = path.join(PATHS.releases, entries[0]!)
    }
    const releaseInfo = releasePath === null ? null : await stat(releasePath)
    return {
      app_version: process.env.PERSONAL_WORKBENCH_APP_VERSION ?? '0.3.0-beta.1', portable: !PATHS.desktopMode, first_run: await this.firstRun.status(), backup_count: backupRows.length,
      latest_backup: backupRows[0] ?? null,
      release_package: {
        path: releasePath, exists: releasePath !== null, sha256: releasePath === null ? null : await hash(releasePath),
        created_at: releaseInfo === null ? null : releaseInfo.mtime.toISOString(),
      },
      media: this.media.capabilities(),
      desktop: {
        enabled: PATHS.desktopMode,
        version: process.env.PERSONAL_WORKBENCH_APP_VERSION ?? '0.3.0-beta.1',
        build_id: process.env.PERSONAL_WORKBENCH_BUILD_ID ?? 'development',
        data_root: PATHS.dataRoot,
        log_root: PATHS.logs,
      },
    }
  }
}
