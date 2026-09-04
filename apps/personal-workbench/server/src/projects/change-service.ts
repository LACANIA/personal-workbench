import type { ProjectChangeSummary } from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'

function extensionNames(rows: { extension: string; count: number }[]): Set<string> {
  return new Set(rows.filter(row => row.count > 0).map(row => row.extension))
}

function roundedRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export class ProjectChangeService {
  constructor(readonly database: WorkbenchDatabase) {}

  summarize(projectId: string): ProjectChangeSummary | null {
    const snapshots = this.database.listProjectAssetSnapshots(projectId, 2)
    if (snapshots.length < 2) return null
    const latest = snapshots[0]!
    const previous = snapshots[1]!
    const fileCountChange = latest.fileCount - previous.fileCount
    const previousExtensions = extensionNames(previous.extensionDistribution)
    const latestExtensions = extensionNames(latest.extensionDistribution)
    return {
      latest_snapshot_id: latest.id,
      previous_snapshot_id: previous.id,
      latest_scan_time: latest.createdAt,
      previous_scan_time: previous.createdAt,
      added_files_estimate: Math.max(0, fileCountChange),
      file_count_change: fileCountChange,
      size_change: latest.totalBytes - previous.totalBytes,
      file_change_ratio: previous.fileCount === 0
        ? (latest.fileCount === 0 ? 0 : 1)
        : roundedRatio(fileCountChange / previous.fileCount),
      new_extensions: [...latestExtensions].filter(extension => !previousExtensions.has(extension)).sort(),
      removed_extensions: [...previousExtensions].filter(extension => !latestExtensions.has(extension)).sort(),
    }
  }
}
