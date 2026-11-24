// What foundation decided for M5, held where a slice cannot quietly move it (ADR-029).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPANY_SEARCH_KINDS,
  type CompanySearchKind,
} from '@ensemus/application/knowledge/company-search';
import {
  GOOGLE_WORKSPACE_MANIFEST,
  KNOWLEDGE_CONNECTOR_MANIFESTS,
  MCP_SERVER_MANIFEST,
} from '@ensemus/connectors/knowledge-manifests';
import { ROUTE_TLS_NAMES } from '@ensemus/connectors/knowledge';
import {
  companySearchKindSchema,
  driveConnectorConfigSchema,
  egressProposalSchema,
  mcpConnectorConfigSchema,
  reviewMcpToolSchema,
} from '@ensemus/contracts/knowledge';
import { actionToolsFor } from '@ensemus/domain/ai-tools';
import { edgeAllowed, MAX_DOCUMENT_BYTES } from '@ensemus/domain/knowledge';
import { can } from '@ensemus/domain/policy';
import { createScriptedModelPort, deterministicVector } from '@ensemus/knowledge/testing';
import { describe, expect, it } from 'vitest';
import { messageFor } from '../../apps/web/src/lib/messages';

const repo = join(import.meta.dirname, '..', '..');
const security = readFileSync(
  join(repo, 'packages/database/migrations/0201_knowledge_security.sql'),
  'utf8',
);
const tables = readFileSync(join(repo, 'packages/database/migrations/0200_knowledge.sql'), 'utf8');

describe('capabilities', () => {
  it('lets no capability stand in for a source ACL, and keeps management from members', () => {
    expect(can('member', 'knowledge.add')).toBe(true);
    for (const capability of [
      'knowledge.manage',
      'knowledge.review_fact',
      'egress.view',
    ] as const) {
      expect(can('member', capability), capability).toBe(false);
      expect(can('admin', capability), capability).toBe(true);
    }
    expect(can('stranger', 'knowledge.add')).toBe(false);
  });
});

describe('the security migration', () => {
  it('starts with the reviewed header', () => {
    expect(security.startsWith('-- REVIEWED SECURITY SQL')).toBe(true);
  });

  it('gives no table in the schema a policy for everyone', () => {
    // Every policy is `TO ensemus_app`, so another role sees nothing, with FORCE on.
    const policies = security.match(/CREATE POLICY[^;]*;/g) ?? [];
    expect(policies.length).toBeGreaterThan(10);
    for (const policy of policies) expect(policy).toContain('TO ensemus_app');
  });

  it('never defines a function that runs with its owner rights', () => {
    expect(security).not.toMatch(/SECURITY DEFINER/i);
  });

  it('grants nothing to the dispatcher or secrets roles', () => {
    expect(security).not.toMatch(/TO ensemus_(dispatcher|secrets|auth)/);
  });

  it('makes the words of a document unreadable through a plain tenant policy', () => {
    for (const table of ['documents', 'chunks', 'embeddings']) {
      expect(security).toContain(`CREATE POLICY acl_read ON knowledge.${table} FOR SELECT`);
    }
    expect(security).toMatch(
      /IF t\.tablename NOT IN \('documents', 'document_staging', 'chunks', 'embeddings', 'facts', 'answers'\)/,
    );
  });

  it('holds every table in the first migration to row-level security, by the loop', () => {
    expect(tables).toContain('CREATE SCHEMA "knowledge"');
    expect(security).toContain(
      "FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'knowledge'",
    );
  });

  it('builds the view with the caller rights', () => {
    expect(security).toContain('WITH (security_invoker = true)');
  });
});

describe('contracts', () => {
  it('cannot name a host in a connector setting', () => {
    expect(driveConnectorConfigSchema.safeParse({ drive_ids: ['abc'] }).success).toBe(true);
    expect(
      driveConnectorConfigSchema.safeParse({ drive_ids: [], host: 'attacker.invalid' }).success,
    ).toBe(false);
    expect(mcpConnectorConfigSchema.safeParse({ endpoint_path: '/mcp' }).success).toBe(true);
    expect(driveConnectorConfigSchema.safeParse({ drive_ids: ['..'] }).success).toBe(false);
    for (const endpoint_path of [
      'https://attacker.invalid/',
      '//attacker.invalid/',
      'mcp',
      '/a/../../b',
    ]) {
      expect(mcpConnectorConfigSchema.safeParse({ endpoint_path }).success, endpoint_path).toBe(
        false,
      );
    }
  });

  it('cannot approve an MCP tool for restricted data', () => {
    expect(
      reviewMcpToolSchema.safeParse({
        decision: 'approve',
        side_effect_level: 'read_only',
        allowed_classes: ['restricted'],
      }).success,
    ).toBe(false);
  });

  it('refuses a URL where a host goes in a proposal', () => {
    const proposal = {
      destination: 'customer_byom_public_api',
      destination_host: 'models.example.invalid',
      billing_owner: 'customer',
      retention_basis: 'unreviewed',
      region: null,
      contract_ref: null,
      allowed_classes: ['internal'],
      purposes: ['embed'],
    };
    expect(egressProposalSchema.safeParse(proposal).success).toBe(true);
    expect(
      egressProposalSchema.safeParse({
        ...proposal,
        destination_host: 'https://models.example.invalid/?k=1',
      }).success,
    ).toBe(false);
  });

  it('agrees with the service on what company search can return', () => {
    expect(companySearchKindSchema.options).toEqual([...COMPANY_SEARCH_KINDS]);
    const kind: CompanySearchKind = companySearchKindSchema.options[0];
    expect(kind).toBe('work_unit');
  });
});

describe('connectors', () => {
  it('fixes each provider host in code', () => {
    expect(ROUTE_TLS_NAMES.google_api).toBe('www.googleapis.com');
    expect(ROUTE_TLS_NAMES.ms_graph).toBe('graph.microsoft.com');
    // ADR-038 D6's suite tools: Gmail, Docs and Sheets have hosts of their own.
    expect(ROUTE_TLS_NAMES.google_gmail).toBe('gmail.googleapis.com');
    expect(ROUTE_TLS_NAMES.google_docs).toBe('docs.googleapis.com');
    expect(ROUTE_TLS_NAMES.google_sheets).toBe('sheets.googleapis.com');
  });

  it('declares only the suite changes its tools name, and reads source permissions on the two that sync', () => {
    // ADR-038 D6: Google's and Microsoft's actions are exactly the suite tools bound to them. An MCP
    // server still declares none: its writes go through a reviewed tool.
    for (const manifest of KNOWLEDGE_CONNECTOR_MANIFESTS) {
      expect([...manifest.capabilities.actions].sort()).toEqual(
        [...actionToolsFor(manifest.type)].sort(),
      );
      expect(manifest.type).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    }
    expect(MCP_SERVER_MANIFEST.capabilities.actions).toEqual([]);
    expect(GOOGLE_WORKSPACE_MANIFEST.capabilities.aclMapping).toBe(true);
  });
});

describe('the rules a slice builds on', () => {
  it('allows only the links in the table', () => {
    expect(edgeAllowed('knowledge_source', 'documents', 'client')).toBe(true);
    expect(edgeAllowed('client', 'documents', 'knowledge_source')).toBe(false);
    expect(edgeAllowed('client', 'constructor', 'client')).toBe(false);
  });

  it('keeps a document under the table check', () => {
    expect(tables).toContain(`between 0 and ${MAX_DOCUMENT_BYTES}`);
  });

  it('has words for every new error', () => {
    for (const code of [
      'KNOWLEDGE_SOURCE_CLOSED',
      'KNOWLEDGE_FORMAT_UNSUPPORTED',
      'KNOWLEDGE_GRANT_TOO_WIDE',
      'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE',
      'KNOWLEDGE_NO_MODEL',
      'KNOWLEDGE_FACT_NEEDS_EVIDENCE',
      'KNOWLEDGE_FACT_NEEDS_PERSON',
      'KNOWLEDGE_ARTIFACT_NOT_GROUNDED',
      'MCP_TOOL_NOT_APPROVED',
      'CLIENT_ONBOARDING_EXISTS',
    ]) {
      expect(messageFor(code), code).not.toBe('Something went wrong. Please try again.');
    }
  });
});

describe('the test double', () => {
  it('counts calls, so a test can prove a denial contacted nobody', async () => {
    const port = createScriptedModelPort({
      route: () => ({ decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'test' }),
    });
    const decision = await port.route({
      organizationId: 'org',
      purpose: 'embed',
      classification: 'restricted',
    });
    expect(decision.decision).toBe('deny');
    expect(port.calls).toEqual([{ method: 'route', purpose: 'embed' }]);
  });

  it('gives the same text the same vector, of the length asked for', () => {
    expect(deterministicVector('words', 4)).toEqual(deterministicVector('words', 4));
    expect(deterministicVector('words', 7)).toHaveLength(7);
  });
});
