import type {
  ArtifactEvidenceView,
  ArtifactProvenanceGraph,
  ProjectProvenanceGraph,
  ProvenanceGraphEdge,
  ProvenanceGraphNode,
} from '../../../shared/contracts/index.ts'
import { WorkbenchDatabase } from '../database.ts'
import { ArtifactEvidenceService } from './evidence-service.ts'

function graphNodeId(type: ProvenanceGraphNode['type'], entityId: string): string {
  return `${type}:${entityId}`
}

function sourceStatus(link: ArtifactEvidenceView, database: WorkbenchDatabase): string {
  if (!link.source.available) return 'unavailable'
  if (link.source_type === 'artifact') return database.getArtifact(link.source_id)?.status ?? 'unavailable'
  const status = link.source.metadata.status
  return typeof status === 'string' && status.length > 0 ? status : 'available'
}

function compareNodes(left: ProvenanceGraphNode, right: ProvenanceGraphNode): number {
  if (left.type === 'artifact' && right.type !== 'artifact') return -1
  if (left.type !== 'artifact' && right.type === 'artifact') return 1
  return left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
}

function compareEdges(left: ProvenanceGraphEdge, right: ProvenanceGraphEdge): number {
  return left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.relation_type.localeCompare(right.relation_type)
    || left.evidence_id.localeCompare(right.evidence_id)
}

export class ProvenanceGraphService {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly evidence: ArtifactEvidenceService,
  ) {}

  artifact(artifactId: string, requestedDepth = 1): ArtifactProvenanceGraph {
    const depth = this.normalizeDepth(requestedDepth)
    const root = this.evidence.forArtifact(artifactId)
    const nodes = new Map<string, ProvenanceGraphNode>()
    const edges = new Map<string, ProvenanceGraphEdge>()
    const visited = new Set<string>()

    const visit = (currentArtifactId: string, remainingDepth: number): void => {
      if (visited.has(currentArtifactId)) return
      visited.add(currentArtifactId)
      const bundle = this.evidence.forArtifact(currentArtifactId)
      if (bundle.artifact.project_id !== root.artifact.project_id) throw new Error('PROVENANCE_PROJECT_DENIED')
      const currentId = graphNodeId('artifact', bundle.artifact.id)
      nodes.set(currentId, {
        id: currentId,
        entity_id: bundle.artifact.id,
        type: 'artifact',
        title: bundle.artifact.name,
        status: bundle.artifact.status,
      })
      for (const link of bundle.evidence) {
        const targetId = graphNodeId(link.source_type, link.source_id)
        if (!nodes.has(targetId)) {
          nodes.set(targetId, {
            id: targetId,
            entity_id: link.source_id,
            type: link.source_type,
            title: link.source.label,
            status: sourceStatus(link, this.database),
          })
        }
        const edge: ProvenanceGraphEdge = {
          source: currentId,
          target: targetId,
          relation_type: link.relation_type,
          evidence_id: link.id,
        }
        edges.set(`${edge.source}\0${edge.target}\0${edge.relation_type}\0${edge.evidence_id}`, edge)
        if (remainingDepth > 1 && link.source_type === 'artifact' && link.source.available) {
          const targetArtifact = this.database.getArtifact(link.source_id)
          if (targetArtifact !== undefined && targetArtifact.project_id === root.artifact.project_id) {
            visit(targetArtifact.id, remainingDepth - 1)
          }
        }
      }
    }

    visit(root.artifact.id, depth)
    return {
      artifact_id: root.artifact.id,
      project_id: root.artifact.project_id,
      depth,
      nodes: [...nodes.values()].sort(compareNodes),
      edges: [...edges.values()].sort(compareEdges),
      generated_at: new Date().toISOString(),
    }
  }

  project(projectId: string): ProjectProvenanceGraph {
    const project = this.database.getProjectContext(projectId)
    if (project === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND')
    const artifacts = this.database.listArtifacts({ project_id: project.id, limit: 500 })
    const nodes = new Map<string, ProvenanceGraphNode>()
    const edges = new Map<string, ProvenanceGraphEdge>()
    for (const artifact of artifacts) {
      const graph = this.artifact(artifact.id)
      if (graph.project_id !== project.id) throw new Error('PROVENANCE_PROJECT_DENIED')
      for (const node of graph.nodes) nodes.set(node.id, node)
      for (const edge of graph.edges) edges.set(`${edge.source}\0${edge.target}\0${edge.relation_type}\0${edge.evidence_id}`, edge)
    }
    return {
      project_id: project.id,
      project_name: project.name,
      artifact_count: artifacts.length,
      nodes: [...nodes.values()].sort(compareNodes),
      edges: [...edges.values()].sort(compareEdges),
      generated_at: new Date().toISOString(),
    }
  }

  private normalizeDepth(value: number): 1 | 2 | 3 {
    if (!Number.isInteger(value) || value < 1 || value > 3) throw new Error('INVALID_PROVENANCE_DEPTH')
    return value as 1 | 2 | 3
  }
}
