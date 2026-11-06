// Owned by the facts slice (KNOW-06). See docs/06-delivery/m5-slices.md and ADR-029 D7. Reads the view
// `knowledge.graph_links`, so structure comes live from the relational tables. A recursive query with
// its depth and size bounded by `GRAPH_MAX_DEPTH` and `GRAPH_MAX_NODES`, which refuses to walk through a
// node the viewer cannot see, so a link cannot reveal what lies past it.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { GraphNode, GraphNodeType } from '@ensemus/domain/knowledge';

export type GraphEdgeView = {
  from: GraphNode;
  relation: string;
  to: GraphNode;
  origin: 'record' | 'person' | 'fact';
};

export type GraphTraversal = {
  nodes: readonly (GraphNode & { depth: number; label: string })[];
  edges: readonly GraphEdgeView[];
  truncated: boolean;
};

/**
 * Needs `knowledge.manage`. For what the tables do not already hold. Refuses a relation the table in
 * `EDGE_RULES` does not allow between those types, and a node in another tenant (a trigger holds this).
 */
export function linkNodes(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { from: GraphNode; relation: string; to: GraphNode },
): Promise<{ edgeId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function unlinkEdge(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { edgeId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Multi-hop from one node the viewer can see. NOT_FOUND if they cannot, the same as if it did not exist.
 * Refuses a service context. Work through `knowledge.can_read_work`, sources through the ACL, and everything
 * else as its own page shows it, at every hop, inside the query.
 */
export function traverseGraph(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    from: GraphNode;
    relations?: readonly string[];
    nodeTypes?: readonly GraphNodeType[];
    depth?: number;
    limit?: number;
  },
): Promise<GraphTraversal> {
  throw new Error('NOT_IMPLEMENTED');
}
