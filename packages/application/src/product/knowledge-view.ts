// Owned by the surfaces slice (UX-18's page, on M5's data). See docs/06-delivery/m7-slices.md. M5 applies
// every access rule. This adds nothing and removes nothing, so it can never widen what someone sees.
import type { TenantContext } from '@ensemus/database';
import type { KnowledgeHit, KnowledgeSourceView, ProductPorts } from './ports';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type KnowledgePage = {
  sources: readonly KnowledgeSourceView[];
  hits: readonly KnowledgeHit[] | null;
};

export async function readKnowledgePage(
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'knowledge'>,
  _input: { query?: string },
): Promise<KnowledgePage> {
  throw NOT_BUILT();
}
