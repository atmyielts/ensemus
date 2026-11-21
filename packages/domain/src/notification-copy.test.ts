import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  notificationPath,
  notificationTitle,
  TITLED_NOTIFICATION_KINDS,
} from './notification-copy';

const ID = '0b6f1d1e-2c3a-4b5c-8d9e-0f1a2b3c4d5e';
const BASE = '/o/org';

describe('notification words', () => {
  it('says an answer is ready, and leads to that answer', () => {
    expect(notificationTitle('knowledge.answer_ready')).toBe(
      'The answer to your question is ready',
    );
    expect(notificationPath(BASE, `knowledge_answer:${ID}`)).toBe(
      `${BASE}/knowledge/answers/${ID}`,
    );
  });

  it('leads each kind of reference to its page', () => {
    expect(notificationPath(BASE, `approval:${ID}`)).toBe(`${BASE}/approvals/${ID}`);
    expect(notificationPath(BASE, `work_unit:${ID}`)).toBe(`${BASE}/work/${ID}`);
    expect(notificationPath(BASE, `invoice:${ID}`)).toBe(`${BASE}/account/invoices/${ID}`);
    expect(notificationPath(BASE, `ticket:${ID}`)).toBe(`${BASE}/account/support/${ID}`);
    expect(notificationPath(BASE, `invitation:${ID}`)).toBe(`${BASE}/people`);
  });

  it('never puts anything but a real ID in a path', () => {
    expect(notificationPath(BASE, 'approval:../../admin')).toBe(`${BASE}/inbox`);
    expect(notificationPath(BASE, 'knowledge_answer:x?y=1')).toBe(`${BASE}/inbox`);
    expect(notificationPath(BASE, 'nothing')).toBe(`${BASE}/inbox`);
    expect(notificationPath(BASE, `unknown_type:${ID}`)).toBe(`${BASE}/inbox`);
  });

  it('has words for every kind the code defines', () => {
    const root = join(import.meta.dirname, '..', '..');
    const sources = [
      ...readdirSync(join(root, 'domain', 'src')).map((name) => join(root, 'domain', 'src', name)),
      join(root, 'saas', 'src', 'events.ts'),
    ].filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
    const kinds = sources.flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/export const NOTIFY_[A-Z_]+ = '([a-z_.]+)'/g)].map(
        (match) => match[1]!,
      ),
    );
    expect(kinds.length).toBeGreaterThan(10);
    for (const kind of kinds) expect(TITLED_NOTIFICATION_KINDS).toContain(kind);
    expect(notificationTitle('something.unexpected')).toBe('Something needs your attention');
  });
});
