// Holds the TypeScript rules for malware scanning, approximate vector search and domain grants to the
// reviewed SQL that enforces them (migrations 0710, 0711 and 0712, ADR-029 addenda).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXACT_VECTOR_SEARCH_MAX_ROWS,
  HNSW_INDEXED_DIMENSIONS,
  SCAN_STATES,
  SCAN_TRANSITIONS,
  scanTransitionAllowed,
  vectorSearchMode,
} from '@ensemus/domain/knowledge';
import { hnswDistance, pgvectorHasIterativeScan } from '@ensemus/application/knowledge/retrieval';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { parse } from 'yaml';

const migrations = join(import.meta.dirname, '../../packages/database/migrations');
const read = (name: string) => readFileSync(join(migrations, name), 'utf8');

describe('malware scan states', () => {
  const scanSql = read('0710_knowledge_scan_states.sql');
  it('flags the security migration for human review on its first line', () => {
    expect(scanSql.split('\n')[0]).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW');
    expect(read('0712_knowledge_domain_grants.sql').split('\n')[0]).toBe(
      '-- FLAGGED FOR HUMAN SECURITY REVIEW',
    );
  });
  it('allows in SQL exactly the moves the domain allows', () => {
    const cases = new Map<string, string[]>();
    for (const match of scanSql.matchAll(/WHEN '(\w+)' THEN NEW\.scan_state IN \(([^)]*)\)/g)) {
      cases.set(
        match[1]!,
        [...match[2]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!),
      );
    }
    for (const from of SCAN_STATES) {
      for (const to of SCAN_STATES) {
        if (from === to) continue;
        expect(scanTransitionAllowed(from, to), `${from} -> ${to}`).toBe(
          (cases.get(from) ?? []).includes(to),
        );
      }
    }
    expect(SCAN_TRANSITIONS.infected).toEqual(['infected']);
  });
  it('keeps an infected document out of search in a check, not only in code', () => {
    expect(scanSql).toContain(
      "CHECK (scan_state <> 'infected' OR state IN ('rejected', 'purged'))",
    );
    expect(scanSql).toContain(
      "CHECK (scan_state IN ('not_scanned', 'clean', 'infected', 'scan_failed'))",
    );
  });
});

describe('approximate vector search', () => {
  const indexSql = read('0711_knowledge_vector_index.sql');
  it('has an index for every width the code would search approximately, on the same cast', () => {
    const found = [
      ...indexSql.matchAll(
        /CREATE INDEX IF NOT EXISTS (\w+) ON knowledge\.embeddings\s+USING hnsw \(\(embedding::public\.(vector|halfvec)\((\d+)\)\) public\.(\w+)_cosine_ops\) WHERE dimension = (\d+);/g,
      ),
    ].map((m) => ({ name: m[1], type: m[2], width: Number(m[3]), ops: m[4], where: Number(m[5]) }));
    expect(found).toHaveLength(Object.keys(HNSW_INDEXED_DIMENSIONS).length);
    for (const index of found) {
      expect(index.width).toBe(index.where);
      expect(index.ops).toBe(index.type);
      expect(HNSW_INDEXED_DIMENSIONS[index.width]).toEqual({ type: index.type, index: index.name });
    }
  });
  it('is exact for small authorized sets and unindexed widths, approximate only past both', () => {
    expect(vectorSearchMode({ dimension: 768, authorizedRows: EXACT_VECTOR_SEARCH_MAX_ROWS })).toBe(
      'exact',
    );
    expect(
      vectorSearchMode({ dimension: 768, authorizedRows: EXACT_VECTOR_SEARCH_MAX_ROWS + 1 }),
    ).toBe('approximate');
    expect(vectorSearchMode({ dimension: 32, authorizedRows: 10_000_000 })).toBe('exact');
  });
  it('uses iterative scans only on pgvector 0.8 or later', () => {
    expect(pgvectorHasIterativeScan('0.7.4')).toBe(false);
    expect(pgvectorHasIterativeScan('0.8.0')).toBe(true);
    expect(pgvectorHasIterativeScan('0.10.1')).toBe(true);
    expect(pgvectorHasIterativeScan('1.0.0')).toBe(true);
    expect(pgvectorHasIterativeScan(undefined)).toBe(false);
  });
  it('writes the index cast from the fixed list only, and the vector as a parameter', () => {
    const query = new PgDialect().sqlToQuery(hnswDistance(sql`e.embedding`, '[1,2]', 3072));
    expect(query.sql).toBe('(e.embedding::public.halfvec(3072)) <=> ($1::public.halfvec(3072))');
    expect(query.params).toEqual(['[1,2]']);
    expect(() => hnswDistance(sql`e.embedding`, '[1]', 17)).toThrow();
  });
});

describe('verified domain grants', () => {
  const domainSql = read('0712_knowledge_domain_grants.sql');
  it('never maps anyone-with-the-link, and only public or internal sources', () => {
    expect(domainSql).not.toMatch(/principal_kind\s*(=|IN)\s*\(?'anyone'/);
    expect(domainSql).toContain(
      "(s.kind = 'connector' AND s.classification IN ('public', 'internal') AND EXISTS (",
    );
    expect(domainSql).toContain("AND a.principal_kind = 'domain'");
  });
  it('requires the setting, a domain this tenant verified, an active member and a verified email', () => {
    for (const rule of [
      'p.organization_id = app.current_organization_id()',
      'AND p.knowledge_domain_grants',
      "AND c.domain_state = 'verified'",
      "AND m.status = 'active'",
      'AND u.email_verified',
      "AND lower(split_part(u.email, '@', 2)) = c.domain",
    ])
      expect(domainSql).toContain(rule);
    expect(domainSql).toContain('knowledge_domain_grants boolean DEFAULT false NOT NULL');
  });
  it('keeps 0201 branches unchanged inside the replaced definition', () => {
    const original = read('0201_knowledge_security.sql');
    const body = (text: string) =>
      /CREATE (?:OR REPLACE )?FUNCTION knowledge\.readable_source_ids[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(
        text,
      )?.[1] ?? '';
    const before = body(original)
      .trim()
      .replace(/\s+\)\s*$/, '');
    expect(body(domainSql)).toContain(before.slice(0, before.lastIndexOf('))))') + 5));
  });
});

describe('the malware scanning overlay', () => {
  type Service = {
    profiles?: string[];
    image?: string;
    ports?: unknown;
    networks?: Record<string, { ipv4_address?: string } | null>;
    environment?: Record<string, string>;
  };
  const text = readFileSync(
    join(import.meta.dirname, '../../infrastructure/compose/compose.malware-scan.yaml'),
    'utf8',
  );
  const overlay = parse(text) as {
    services: Record<string, Service>;
    networks: Record<string, { internal?: boolean }>;
  };
  const base = readFileSync(
    join(import.meta.dirname, '../../infrastructure/compose/compose.yaml'),
    'utf8',
  );
  it('runs clamd only under its profile, pinned by digest, on an internal network, publishing nothing', () => {
    const clamav = overlay.services.clamav!;
    expect(clamav.profiles).toEqual(['malware-scan']);
    expect(clamav.image).toMatch(/^clamav\/clamav:[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(clamav.ports).toBeUndefined();
    expect(Object.keys(clamav.networks ?? {})).toEqual(['scanning']);
    expect(overlay.networks.scanning?.internal).toBe(true);
    expect(clamav.environment?.CLAMAV_NO_FRESHCLAMD).toBe('true');
  });
  it('points the knowledge worker at the pinned address, and leaves compose.yaml without a scanner', () => {
    const worker = overlay.services['knowledge-worker']!;
    const address = clamavAddress(overlay.services.clamav!);
    expect(worker.environment?.ENSEMUS_CLAMD_ADDRESS).toContain(address.replace(/^.*\}/, ''));
    expect(Object.keys(worker.networks ?? {})).toEqual(['scanning']);
    expect(base).not.toMatch(/clamav/i);
  });
});

function clamavAddress(service: { networks?: Record<string, { ipv4_address?: string } | null> }) {
  return service.networks?.scanning?.ipv4_address ?? '';
}
