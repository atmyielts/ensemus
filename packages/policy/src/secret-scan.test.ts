// SEC-13, the scan half of QA-018. Everything key-shaped is assembled at runtime, so no literal that looks like
// a key is ever committed and push protection stays quiet. None of these unlocks anything.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyShapedText, pemShapedText, tenantCanary } from '../../../tests/helpers/ai/canaries';
import { scanForSecrets } from './secret-scan';
import type { ScanResult, SecretCode } from './types';

const noise = (bytes = 24) => randomBytes(bytes).toString('hex');
const upperNoise = (length: number) =>
  randomBytes(length).toString('hex').toUpperCase().slice(0, length);
const glue = (...parts: string[]) => parts.join('');

const scanOne = (text: string, canaries: readonly string[] = []) =>
  scanForSecrets([{ id: 'part', text }], canaries);

const codes = (result: ScanResult) => result.hits.map((hit) => hit.code);

const SHAPES: readonly [string, SecretCode, () => string][] = [
  ['a PEM private key', 'PEM_BLOCK', pemShapedText],
  [
    'an RSA PEM opening line alone',
    'PEM_BLOCK',
    () => glue('-----', 'BEGIN RSA ', 'PRIVATE KEY', '-----'),
  ],
  [
    'an OpenSSH block',
    'PEM_BLOCK',
    () => glue('-----', 'BEGIN OPENSSH ', 'PRIVATE KEY', '-----\n', noise()),
  ],
  ['an sk- key', 'API_KEY_SHAPE', keyShapedText],
  ['a project sk- key', 'API_KEY_SHAPE', () => glue('s', 'k-', 'proj-', noise())],
  ['a payment key', 'API_KEY_SHAPE', () => glue('s', 'k_', 'live_', noise())],
  ['a GitHub token', 'API_KEY_SHAPE', () => glue('gh', 'p_', noise())],
  ['a fine-grained GitHub token', 'API_KEY_SHAPE', () => glue('github', '_pat_', noise())],
  ['a GitLab token', 'API_KEY_SHAPE', () => glue('gl', 'pat-', noise())],
  ['a Slack token', 'API_KEY_SHAPE', () => glue('xo', 'xb-', noise())],
  ['a mail provider key', 'API_KEY_SHAPE', () => glue('S', 'G.', noise(), '.', noise())],
  ['a named key', 'API_KEY_SHAPE', () => `API_KEY="${noise()}"`],
  ['a named client secret', 'API_KEY_SHAPE', () => `client_secret: ${noise()}`],
  ['a bearer header', 'BEARER_TOKEN_SHAPE', () => `Authorization: Bearer ${noise()}`],
  ['a basic header', 'BEARER_TOKEN_SHAPE', () => `Authorization: Basic ${noise()}`],
  [
    'a JSON web token',
    'BEARER_TOKEN_SHAPE',
    () => glue('ey', 'J', noise(), '.', 'ey', 'J', noise(), '.', noise()),
  ],
  ['an access key ID', 'CLOUD_KEY_SHAPE', () => glue('AK', 'IA', upperNoise(16))],
  ['a named cloud secret', 'CLOUD_KEY_SHAPE', () => `aws_secret_access_key = ${noise()}`],
  ['a Google key', 'CLOUD_KEY_SHAPE', () => glue('AI', 'za', noise(32).slice(0, 35))],
  [
    'a service account file',
    'CLOUD_KEY_SHAPE',
    () => '{ "type": "service_account", "project_id": "x" }',
  ],
  ['a storage connection string', 'CLOUD_KEY_SHAPE', () => glue('AccountKey=', noise(32), '==')],
];

describe('scanForSecrets', () => {
  for (const [name, code, make] of SHAPES) {
    it(`finds ${name}`, () => {
      expect(codes(scanOne(`Here is the file: ${make()} and more words.`))).toContain(code);
    });

    it(`returns no content for ${name}`, () => {
      const secret = make();
      const serialised = JSON.stringify(scanOne(`before ${secret} after`));
      expect(serialised).not.toContain(secret);
      expect(serialised).not.toContain('before');
      expect(serialised).not.toContain('after');
      for (const hit of scanOne(secret).hits) {
        expect(Object.keys(hit).sort()).toEqual(['code', 'partId']);
      }
    });
  }

  describe('canaries', () => {
    it('finds a tenant canary, and reports it by code', () => {
      const canary = tenantCanary();
      expect(scanOne(`text ${canary} text`, [canary]).hits).toEqual([
        { partId: 'part', code: 'TENANT_CANARY' },
      ]);
    });

    it('finds one in another case', () => {
      const canary = tenantCanary();
      expect(codes(scanOne(canary.toUpperCase(), [canary]))).toEqual(['TENANT_CANARY']);
    });

    it('finds one hidden with zero-width marks', () => {
      const canary = tenantCanary();
      const hidden = `${canary.slice(0, 8)}\u200B${canary.slice(8)}`;
      expect(codes(scanOne(hidden, [canary]))).toEqual(['TENANT_CANARY']);
    });

    it('does not report a canary that is not there', () => {
      expect(scanOne('nothing here', [tenantCanary()]).hits).toEqual([]);
    });

    it('ignores an empty canary, which would otherwise match every part', () => {
      expect(scanOne('nothing here', ['', '   ']).hits).toEqual([]);
    });

    it('returns no canary in its result', () => {
      const canary = tenantCanary();
      expect(JSON.stringify(scanOne(canary, [canary]))).not.toContain(canary);
    });
  });

  describe('text meant to get past it', () => {
    it('finds a key with zero-width marks inside it', () => {
      const key = keyShapedText();
      expect(codes(scanOne(`${key.slice(0, 10)}‍${key.slice(10)}`))).toContain('API_KEY_SHAPE');
    });

    it('finds a key written in full-width letters', () => {
      const key = keyShapedText();
      const wide = [...key]
        .map((character) => {
          const code = character.charCodeAt(0);
          return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : character;
        })
        .join('');
      expect(codes(scanOne(wide))).toContain('API_KEY_SHAPE');
    });
  });

  describe('text it should leave alone', () => {
    for (const text of [
      'nothing here',
      'The bearer of this letter is a friend.',
      'We assessed the risk-adjusted-return-of-the-portfolio over several quarters and years.',
      'Our task-management-and-reporting-system-for-teams needs an update.',
      'The API key is stored in the vault, and nobody has it.',
      'Basic training begins on Monday.',
      'Words about a secret key: nothing long enough follows.',
    ]) {
      it(`does not flag: ${text}`, () => {
        expect(scanOne(text).hits).toEqual([]);
      });
    }

    it('handles empty text and no parts', () => {
      expect(scanOne('').hits).toEqual([]);
      expect(scanForSecrets([]).hits).toEqual([]);
    });
  });

  describe('its report', () => {
    it('says which part, for each part', () => {
      const canary = tenantCanary();
      const result = scanForSecrets(
        [
          { id: 'clean', text: 'nothing here' },
          { id: 'keyed', text: keyShapedText() },
          { id: 'marked', text: canary },
        ],
        [canary],
      );
      expect(result.hits).toEqual([
        { partId: 'keyed', code: 'API_KEY_SHAPE' },
        { partId: 'marked', code: 'TENANT_CANARY' },
      ]);
    });

    it('reports a code once per part, however often it matches', () => {
      expect(scanOne(`${keyShapedText()} ${keyShapedText()}`).hits).toHaveLength(1);
    });

    it('reports every code a part holds', () => {
      expect(codes(scanOne(`${keyShapedText()} ${pemShapedText()}`)).sort()).toEqual([
        'API_KEY_SHAPE',
        'PEM_BLOCK',
      ]);
    });

    it('gives the same answer twice, so no pattern carries state between calls', () => {
      const text = keyShapedText();
      expect(scanOne(text)).toEqual(scanOne(text));
    });

    it('treats a part it cannot read as holding a key', () => {
      const unreadable = [{ id: 'part', text: null }] as unknown as { id: string; text: string }[];
      expect(scanForSecrets(unreadable).hits).toEqual([{ partId: 'part', code: 'API_KEY_SHAPE' }]);
    });
  });

  it('stays linear on text built to make a pattern backtrack', () => {
    // One at a time, because a part stops at its first match and would otherwise hide the slow pattern.
    const hostile = [
      'sk-a'.repeat(4).repeat(50_000),
      'api_key'.repeat(100_000),
      `${' '.repeat(500_000)}bearer`,
      'bearer '.repeat(100_000),
      '-----BEGIN '.repeat(100_000),
      '-----BEGIN a'.repeat(100_000),
      'eyJ-'.repeat(250_000),
      'eyJaaaaaaaaaa.'.repeat(50_000),
      'SG.'.repeat(200_000),
      'AKIA'.repeat(250_000),
      'a'.repeat(1_000_000),
    ];
    const started = performance.now();
    for (const text of hostile) scanOne(text);
    // Generous on purpose: a quadratic pattern on this input would take minutes, not seconds.
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
