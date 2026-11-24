// Platform email (0570, 0571): the reviewed SQL, the network shape and the code agree with each other.
// The database behaviour itself is in tests/integration/platform-mail.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_MAIL_LINK_PURPOSE, ACCOUNT_MAIL_LINK_SCOPE } from '@ensemus/auth/account-mail';
import {
  ACCOUNT_MAIL_KINDS,
  ACCOUNT_MAIL_SCOPE,
  MAIL_LINK_PURPOSE,
  MAIL_STATUSES,
  MAIL_TRANSITIONS,
  NOTIFICATION_DELIVERIES,
  NOTIFICATION_TOPICS,
  TENANT_MAIL_KINDS,
} from '@ensemus/domain/mail';
import { repoRoot } from '../helpers/stack';

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const migrations = 'packages/database/migrations';
const tables = read(`${migrations}/0570_platform_mail.sql`);
const security = read(`${migrations}/0571_platform_mail_security.sql`);
const compose = read('infrastructure/compose/compose.yaml');
const testCompose = read('infrastructure/compose/compose.test.yaml');

/** One service's block from a compose file, by its two-space indented name. */
function service(file: string, name: string): string {
  const start = file.indexOf(`\n  ${name}:\n`);
  expect(start, `${name} is in the compose file`).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('the reviewed SQL', () => {
  it('is flagged for a person to review', () => {
    expect(security.split(/\r?\n/)[0]).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW');
    expect(read('infrastructure/compose/postgres/upgrade-roles-mail.sql').split(/\r?\n/)[0]).toBe(
      '-- FLAGGED FOR HUMAN SECURITY REVIEW',
    );
  });

  it('has the same arrows as MAIL_TRANSITIONS', () => {
    const block = /allowed := CASE OLD\.status([\s\S]*?)END;/.exec(security)?.[1] ?? '';
    const arrows: Record<string, string[]> = {};
    for (const match of block.matchAll(
      /WHEN '([a-z]+)' THEN NEW\.status(?: IN \(([^)]*)\)|='([a-z]+)')/g,
    )) {
      arrows[match[1]!] = match[2]
        ? [...match[2].matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
        : [match[3]!];
    }
    const expected = Object.fromEntries(
      Object.entries(MAIL_TRANSITIONS).filter(([, to]) => to.length > 0),
    );
    expect(arrows).toEqual(expected);
  });

  it('allows the same kinds, statuses, topics and choices as the code', () => {
    const list = (constraint: string, sql: string) =>
      [
        ...(
          new RegExp(`"${constraint}" CHECK \\([^)]*in \\(([^)]*)\\)`).exec(sql)?.[1] ?? ''
        ).matchAll(/'([a-z_]+)'/g),
      ].map((m) => m[1]);
    expect(list('account_mail_outbox_kind', tables)).toEqual([...ACCOUNT_MAIL_KINDS]);
    expect(list('mail_outbox_kind', tables)).toEqual([...TENANT_MAIL_KINDS]);
    expect(list('mail_outbox_status', tables)).toEqual([...MAIL_STATUSES]);
    expect(list('notification_preferences_topic', tables)).toEqual([...NOTIFICATION_TOPICS]);
    expect(list('notification_preferences_delivery', tables)).toEqual([...NOTIFICATION_DELIVERIES]);
  });

  it('gives the dispatcher nothing, and the agent no preferences or unsubscribe links', () => {
    expect(security).not.toMatch(/TO ensemus_dispatcher/);
    expect(security).toMatch(
      /agent_none ON org\.notification_preferences AS RESTRICTIVE TO ensemus_agent/,
    );
    expect(security).toMatch(
      /agent_none ON platform\.mail_unsubscribe_tokens AS RESTRICTIVE TO ensemus_agent/,
    );
  });

  it('holds every mail-worker reach to restore admission', () => {
    const reach =
      /FOREACH t IN ARRAY ARRAY\[('platform\.account_mail_outbox'[\s\S]*?)\] LOOP\s+EXECUTE format\('CREATE POLICY mail_delivery_read/.exec(
        security,
      )?.[1];
    expect(reach).toBeDefined();
    const granted = [
      ...security.matchAll(/GRANT [^;]*? ON ([a-z_.,\s]+?) TO ensemus_mailer/g),
    ].flatMap((match) => match[1]!.split(',').map((table) => table.trim()));
    for (const table of granted.filter((t) => t.includes('.') && !t.startsWith('FUNCTION')))
      expect(reach).toContain(`'${table}'`);
  });

  it('is journaled after every earlier migration', () => {
    const journal = JSON.parse(read(`${migrations}/meta/_journal.json`)) as {
      entries: { tag: string }[];
    };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags.indexOf('0571_platform_mail_security')).toBe(
      tags.indexOf('0570_platform_mail') + 1,
    );
  });

  it('seals links the same way in the auth tier and the worker', () => {
    expect(ACCOUNT_MAIL_LINK_PURPOSE).toBe(MAIL_LINK_PURPOSE);
    expect(ACCOUNT_MAIL_LINK_SCOPE).toBe(ACCOUNT_MAIL_SCOPE);
  });
});

describe('the network', () => {
  it('gives the mail worker no route out, and its gateway no secret', () => {
    const worker = service(compose, 'mail-worker');
    expect(worker).toMatch(/profiles: \['mail'\]/);
    expect(worker).toMatch(/networks: \[mail\]/);
    expect(worker).not.toMatch(/TEMPORAL|OBJECT_STORAGE|DATABASE_URL_APP/);
    expect(worker).toMatch(/ENSEMUS_MAIL_TLS: \$\{ENSEMUS_MAIL_TLS:-required\}/);
    const gateway = service(compose, 'mail-gateway');
    expect(gateway).toMatch(/profiles: \['mail'\]/);
    expect(gateway).toMatch(/mail: \{ ipv4_address/);
    expect(gateway).toMatch(/outbound: \{\}/);
    expect(gateway).not.toMatch(/secrets:/);
    const network = /\n {2}mail:\n {4}internal: true\n/.test(compose);
    expect(network).toBe(true);
    expect(service(compose, 'web')).not.toMatch(/\n {6}mail:/);
  });

  it('runs the test mailbox only in the test overlay', () => {
    expect(compose).not.toContain('mailpit');
    expect(service(testCompose, 'mailpit')).toMatch(/axllent\/mailpit:v[\d.]+@sha256:[0-9a-f]{64}/);
    expect(service(testCompose, 'mail-worker')).toMatch(/ENSEMUS_MAIL_TLS: none/);
  });

  it('provisions the mailer login before every migration', () => {
    expect(read('infrastructure/compose/postgres/upgrade-roles.sh')).toContain(
      '/provision/upgrade-roles-mail.sql',
    );
    expect(service(compose, 'provision-roles')).toContain('upgrade-roles-mail.sql');
    expect(read('infrastructure/scripts/generate-test-secrets.mjs')).toContain('db_mailer_url');
  });

  it('keeps the mailer role out of every file but the mail worker', () => {
    const lint = read('eslint.config.mjs');
    expect(lint).toContain("group: ['@ensemus/database/mailer']");
    const files = /const mailWorkerFiles = \[([^\]]*)\]/.exec(lint)?.[1] ?? '';
    expect([...files.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual([
      'workers/workflow/src/mail-worker.ts',
      'workers/workflow/src/mail/**/*.ts',
    ]);
  });
});
