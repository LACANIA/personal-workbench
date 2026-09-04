import type { ArtifactProvenanceGraph, ProvenanceGraphNode } from '../../../shared/contracts/index.ts'

interface Point {
  x: number
  y: number
}

function compact(value: string, maximum = 24): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function nodePositions(graph: ArtifactProvenanceGraph, width: number, height: number): Map<string, Point> {
  const center = { x: width / 2, y: height / 2 }
  const root = graph.nodes.find(node => node.type === 'artifact' && node.entity_id === graph.artifact_id)
  const satellites = graph.nodes.filter(node => node.id !== root?.id)
  const positions = new Map<string, Point>()
  if (root !== undefined) positions.set(root.id, center)
  const radiusX = Math.min(270, width * 0.38)
  const radiusY = Math.min(130, height * 0.36)
  satellites.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, satellites.length)
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radiusX,
      y: center.y + Math.sin(angle) * radiusY,
    })
  })
  return positions
}

function nodeClass(node: ProvenanceGraphNode): string {
  return `provenance-node provenance-node-${node.type} provenance-node-${node.status}`
}

export function ProvenanceGraph({ graph }: { graph: ArtifactProvenanceGraph }): JSX.Element {
  const width = 720
  const height = 360
  const positions = nodePositions(graph, width, height)
  const markerId = `provenance-arrow-${graph.artifact_id.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  return <div className="provenance-graph-wrap">
    <svg className="provenance-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Artifact Provenance Graph">
      <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
      {graph.edges.map(edge => {
        const source = positions.get(edge.source)
        const target = positions.get(edge.target)
        if (source === undefined || target === undefined) return null
        const middleX = (source.x + target.x) / 2
        const middleY = (source.y + target.y) / 2
        return <g key={edge.evidence_id} className="provenance-edge">
          <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd={`url(#${markerId})`} />
          <text x={middleX} y={middleY - 6}>{edge.relation_type}</text>
        </g>
      })}
      {graph.nodes.map(node => {
        const point = positions.get(node.id)
        if (point === undefined) return null
        const root = node.type === 'artifact' && node.entity_id === graph.artifact_id
        return <g key={node.id} className={nodeClass(node)} transform={`translate(${point.x} ${point.y})`}>
          <circle r={root ? 42 : 34} />
          <text className="provenance-node-type" textAnchor="middle" y={-6}>{node.type}</text>
          <text className="provenance-node-title" textAnchor="middle" y={10}>{compact(node.title, root ? 18 : 14)}</text>
          <title>{`${node.type}: ${node.title} · ${node.status}`}</title>
        </g>
      })}
    </svg>
  </div>
}
