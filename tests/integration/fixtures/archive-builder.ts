// Makes an organization archive for tests, without a database, in exactly the shape export writes: a plain tar
// of sealed parts, with a sealed manifest. Generated keys and `@example.invalid` values only. Used by
// tests/unit/hostile-archive.test.ts and tests/integration/organization-import.test.ts until `export` lands, and
// every way of damaging an archive is a choice here rather than a second copy of the format.
import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import type { CoreRecord, ExportManifest } from '@ensemus/contracts/portability-records';
import {
  artifactPartPath,
  knowledgePartPath,
  EXPORT_MANIFEST_PATH,
  EXPORT_SECTIONS,
  recordPartPath,
  type ExportSection,
} from '@ensemus/domain/portability';
import { seal } from '@ensemus/sovereign/sealed';
import { tarEnd, tarHeader, tarPadding } from '@ensemus/sovereign/tar';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export type TarFile = { path: string; bytes: Buffer };
type ManifestPart = ExportManifest['parts'][number];

export type Recipient = { publicKey: KeyObject; keyId: string };

/** A tar from files in order. `linkTo` writes a symbolic link in place of a file, for refusing one. */
export function buildTar(files: readonly (TarFile & { linkTo?: boolean })[]) {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = tarHeader(file.path, file.linkTo ? 0 : file.bytes.length);
    if (file.linkTo) {
      header.write('2', 156, 'ascii');
      header.fill(' ', 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    }
    blocks.push(header);
    if (!file.linkTo) blocks.push(file.bytes, tarPadding(file.bytes.length));
  }
  blocks.push(tarEnd());
  return Buffer.concat(blocks);
}

export const archiveReader = (bytes: Buffer) => ({
  totalBytes: bytes.length,
  readAt: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
});

/** Bytes as one sealed part, and the manifest's line for it. */
export function sealPart(
  recipient: Recipient,
  section: ExportSection,
  path: string,
  plain: Buffer,
  records: number,
): { file: TarFile; part: ManifestPart } {
  const sealed = seal(plain, recipient.publicKey);
  return {
    file: { path, bytes: sealed },
    part: {
      path,
      section,
      records,
      plaintext_sha256: sha256(plain),
      sealed_sha256: sha256(sealed),
      sealed_bytes: sealed.length,
    },
  };
}

export const jsonLines = (records: readonly unknown[]) =>
  Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(''));

/** What goes in: pages of records by section, a part to each, and files' bytes by artifact ID. */
export type ArchiveSpec = {
  pages: readonly {
    section: ExportSection;
    recordKind: string;
    records: readonly (CoreRecord | Record<string, unknown>)[];
  }[];
  files?: Readonly<Record<string, Buffer>>;
  knowledgeFiles?: Readonly<Record<string, Buffer>>;
  organizationId?: string;
  exportId?: string;
  excluded?: ExportManifest['excluded'];
};

export type BuiltArchive = {
  manifest: ExportManifest;
  files: TarFile[];
  bytes: Buffer;
  reader: ReturnType<typeof archiveReader>;
};

export function manifestFor(
  recipient: Recipient,
  parts: readonly ManifestPart[],
  spec: Pick<ArchiveSpec, 'organizationId' | 'exportId' | 'excluded'>,
): ExportManifest {
  const sections: ExportManifest['sections'] = {};
  for (const section of EXPORT_SECTIONS) sections[section] = { records: 0, parts: 0 };
  for (const part of parts) {
    const totals = sections[part.section] ?? { records: 0, parts: 0 };
    sections[part.section] = { records: totals.records + part.records, parts: totals.parts + 1 };
  }
  const now = new Date().toISOString();
  return {
    format: 'ensemus.organization_export',
    schema_version: 1,
    export_id: spec.exportId ?? randomUUID(),
    organization_id: spec.organizationId ?? randomUUID(),
    exported_at: now,
    snapshot_at: now,
    tombstones_through: now,
    initiated_by_membership_id: randomUUID(),
    source_release: 'test',
    scope: 'standard',
    excluded: spec.excluded ?? {
      restricted_work: 0,
      restricted_artifacts: 0,
      restricted_clients: 0,
    },
    sections,
    parts: [...parts],
    encryption: { scheme: 'ensemus.sealed/v1', recipient_key_id: recipient.keyId },
  };
}

/** Seals a manifest, which may be anything at all when a test wants it to be wrong. */
export const sealManifest = (recipient: Recipient, manifest: unknown): TarFile => ({
  path: EXPORT_MANIFEST_PATH,
  bytes: seal(Buffer.from(JSON.stringify(manifest)), recipient.publicKey),
});

/**
 * A whole archive. `alter` gets the manifest and the files before they are sealed into a tar, and is how a test
 * changes one thing while everything else stays honest.
 */
export function buildArchive(
  recipient: Recipient,
  spec: ArchiveSpec,
  alter?: (archive: { manifest: ExportManifest; files: TarFile[] }) => {
    manifest?: unknown;
    files?: (TarFile & { linkTo?: boolean })[];
  } | void,
): BuiltArchive {
  const sequences = new Map<string, number>();
  const parts: ManifestPart[] = [];
  const files: TarFile[] = [];
  for (const page of spec.pages) {
    const name = `${page.section}/${page.recordKind}`;
    const sequence = (sequences.get(name) ?? 0) + 1;
    sequences.set(name, sequence);
    const built = sealPart(
      recipient,
      page.section,
      recordPartPath(page.section, page.recordKind, sequence),
      jsonLines(page.records),
      page.records.length,
    );
    parts.push(built.part);
    files.push(built.file);
  }
  for (const [artifactId, body] of Object.entries(spec.files ?? {})) {
    const built = sealPart(recipient, 'artifacts', artifactPartPath(artifactId), body, 1);
    parts.push(built.part);
    files.push(built.file);
  }
  for (const [documentId, body] of Object.entries(spec.knowledgeFiles ?? {})) {
    const built = sealPart(recipient, 'knowledge', knowledgePartPath(documentId), body, 0);
    parts.push(built.part);
    files.push(built.file);
  }
  const manifest = manifestFor(recipient, parts, spec);
  const altered = alter?.({ manifest, files }) ?? {};
  const finalFiles = altered.files ?? files;
  const bytes = buildTar([sealManifest(recipient, altered.manifest ?? manifest), ...finalFiles]);
  return { manifest, files, bytes, reader: archiveReader(bytes) };
}

const at = '2026-01-02T03:04:05.000Z';
export const artifactBytes = (name: string) => Buffer.from(`The bytes of ${name}.`);
const sha256Of = (body: Buffer) => sha256(body);

/** One of everything, in a source organization, with IDs generated each time. The spec, and the IDs to check. */
export function sourceTenant(names = 'Source') {
  const ids = {
    organization: randomUUID(),
    ada: randomUUID(),
    grace: randomUUID(),
    team: randomUUID(),
    childTeam: randomUUID(),
    client: randomUUID(),
    project: randomUUID(),
    parentWork: randomUUID(),
    childWork: randomUUID(),
    movingWork: randomUUID(),
    pendingWork: randomUUID(),
    keptFile: randomUUID(),
    deletedFile: randomUUID(),
    connection: randomUUID(),
    approval: randomUUID(),
    send: randomUUID(),
    audit: randomUUID(),
  };
  const workUnit = (id: string, overrides: Record<string, unknown>) => ({
    kind: 'work_unit',
    id,
    project_id: ids.project,
    parent_id: null,
    owner_membership_id: ids.ada,
    created_by_membership_id: ids.grace,
    title: `${names} work ${id.slice(0, 8)}`,
    objective: null,
    status: 'queued',
    completion_criteria: [],
    execution_plan: null,
    classification: 'internal',
    due_at: null,
    created_at: at,
    updated_at: at,
    ...overrides,
  });
  const kept = artifactBytes(`${names} kept file`);
  const spec: ArchiveSpec = {
    organizationId: ids.organization,
    pages: [
      {
        section: 'organizations',
        recordKind: 'organizations',
        records: [
          {
            kind: 'organization',
            name: `${names} Ltd`,
            commercial_mode: 'sovereign',
            created_at: at,
          },
        ],
      },
      {
        section: 'people',
        recordKind: 'people',
        records: [
          {
            kind: 'person',
            membership_id: ids.ada,
            display_name: `${names} Ada`,
            email: `ada-${ids.ada}@example.invalid`,
            role: 'owner',
            status: 'active',
            created_at: at,
          },
          {
            kind: 'person',
            membership_id: ids.grace,
            display_name: `${names} Grace`,
            email: `grace-${ids.grace}@example.invalid`,
            role: 'member',
            status: 'active',
            created_at: at,
          },
        ],
      },
      {
        section: 'people',
        recordKind: 'teams',
        records: [
          // The child first, so nothing can pass by reading parents in order.
          {
            kind: 'team',
            id: ids.childTeam,
            parent_id: ids.team,
            name: `${names} child team`,
            created_at: at,
          },
          { kind: 'team', id: ids.team, parent_id: null, name: `${names} team`, created_at: at },
        ],
      },
      {
        section: 'people',
        recordKind: 'team_memberships',
        records: [{ kind: 'team_membership', team_id: ids.team, membership_id: ids.grace }],
      },
      {
        section: 'clients',
        recordKind: 'clients',
        records: [
          {
            kind: 'client',
            id: ids.client,
            display_name: `${names} client`,
            classification: 'internal',
            created_at: at,
          },
        ],
      },
      {
        section: 'projects',
        recordKind: 'projects',
        records: [
          {
            kind: 'project',
            id: ids.project,
            client_id: ids.client,
            name: `${names} project`,
            created_at: at,
          },
        ],
      },
      {
        section: 'work',
        recordKind: 'work_units',
        records: [
          workUnit(ids.childWork, { parent_id: ids.parentWork, status: 'completed' }),
          workUnit(ids.parentWork, { status: 'ready', execution_plan: 'checklist' }),
          workUnit(ids.movingWork, { status: 'running', owner_membership_id: ids.grace }),
          workUnit(ids.pendingWork, { status: 'awaiting_approval' }),
        ],
      },
      {
        section: 'artifacts',
        recordKind: 'artifacts',
        records: [
          {
            kind: 'artifact',
            id: ids.keptFile,
            name: `${names} kept.txt`,
            sha256: sha256Of(kept),
            mime_type: 'text/plain',
            size_bytes: kept.length,
            classification: 'internal',
            created_by_membership_id: ids.ada,
            created_at: at,
          },
        ],
      },
      {
        section: 'relations',
        recordKind: 'work_dependencies',
        records: [
          {
            kind: 'work_dependency',
            prerequisite_id: ids.parentWork,
            dependent_id: ids.movingWork,
          },
        ],
      },
      {
        section: 'relations',
        recordKind: 'work_assignments',
        records: [
          {
            kind: 'work_assignment',
            work_unit_id: ids.parentWork,
            membership_id: ids.grace,
            responsibility: 'reviewer',
            actor_type: 'human',
          },
        ],
      },
      {
        section: 'relations',
        recordKind: 'work_artifacts',
        records: [
          { kind: 'work_artifact', work_unit_id: ids.parentWork, artifact_id: ids.keptFile },
        ],
      },
      {
        section: 'history',
        recordKind: 'approvals',
        records: [
          {
            kind: 'history',
            record_type: 'approval',
            source_id: ids.approval,
            work_unit_id: ids.pendingWork,
            occurred_at: at,
            record: { status: 'pending', tool: 'work.review' },
          },
          {
            kind: 'history',
            record_type: 'external_action',
            source_id: ids.send,
            work_unit_id: ids.parentWork,
            occurred_at: at,
            record: { status: 'ready' },
          },
        ],
      },
      {
        section: 'connections',
        recordKind: 'connections',
        records: [
          {
            kind: 'connection',
            id: ids.connection,
            connector_type: 'test_connector',
            display_name: `${names} connection`,
            granted_scopes: ['read'],
            created_at: at,
          },
        ],
      },
      {
        section: 'tombstones',
        recordKind: 'tombstones',
        records: [
          {
            kind: 'tombstone',
            target_type: 'artifact',
            target_id: ids.deletedFile,
            deleted_at: at,
          },
        ],
      },
      {
        section: 'audit-redacted',
        recordKind: 'audit_events',
        records: [
          {
            kind: 'history',
            record_type: 'audit_event',
            source_id: ids.audit,
            work_unit_id: null,
            occurred_at: at,
            record: { action: 'work.created', decision: 'allow' },
          },
        ],
      },
    ],
    files: { [ids.keptFile]: kept },
  };
  return { spec, ids, kept };
}
