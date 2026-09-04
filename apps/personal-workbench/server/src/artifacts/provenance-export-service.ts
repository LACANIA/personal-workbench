import type { ArtifactProvenanceManifest } from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactService } from './service.ts'

export class ProvenanceExportService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly artifacts: ArtifactService,
  ) {}

  manifest(artifactId: string): ArtifactProvenanceManifest {
    const artifact = this.artifacts.get(artifactId)
    const relations = this.database.listArtifactEvidenceLinks(artifact.id).map(link => ({
      evidence_id: link.id,
      source_type: link.source_type,
      source_id: link.source_id,
      relation_type: link.relation_type,
    }))
    return {
      manifest_version: '1',
      artifact: {
        id: artifact.id,
        project_id: artifact.project_id,
        task_id: artifact.task_id,
        artifact_type: artifact.artifact_type,
        status: artifact.status,
      },
      hash: artifact.sha256,
      relations,
      created_at: new Date().toISOString(),
    }
  }
}
