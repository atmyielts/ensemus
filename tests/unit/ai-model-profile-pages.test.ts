// MODEL-01, SEC-016, QA-024 (API and UI): the model settings forms, and what their source can reach. The
// same things read from a running site, by canary and RSC scan, are in tests/browser/specs/models.spec.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createModelProfileSchema, updateModelProfileSchema } from '@ensemus/contracts/ai';
import {
  createInputFromForm,
  microsToUsd,
  modelCredentialRequestSchema,
  modelKeySchema,
  STATUS_LOOK,
  updateInputFromForm,
  usdPerMtokToMicros,
} from '../../apps/web/src/app/o/[organizationId]/settings/models/model-form';
import { repoRoot } from '../helpers/stack';

const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of [value].flat()) data.append(name, one);
  }
  return data;
};

const filled = {
  alias: '  A model ',
  modelId: 'a-model',
  endpointUrl: 'https://models.example.invalid/v1',
  region: '',
  maxInputTokens: '4096',
  maxOutputTokens: '512',
  capabilities: ['text', 'tools'],
  allowedClasses: ['public'],
  allowedPurposes: ['reason'],
  retentionBasis: 'unreviewed',
  contractRef: '',
};

describe('the create form', () => {
  it('makes what the contract accepts', () => {
    const input = createInputFromForm(form({ ...filled, providerKind: 'openai_compatible' }));
    expect(createModelProfileSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      alias: 'A model',
      region: null,
      contract_ref: null,
      limits: { max_input_tokens: 4096, max_output_tokens: 512 },
    });
  });

  it('always says the customer pays, whatever the form was made to send', () => {
    const input = createInputFromForm(
      form({ ...filled, providerKind: 'openai_compatible', billing_owner: 'ensemus' }),
    );
    expect(input.billing_owner).toBe('customer');
  });

  it('never carries a key, even if one is sent', () => {
    const key = `test-key-${randomUUID()}`;
    const input = createInputFromForm(
      form({ ...filled, providerKind: 'openai_compatible', key, secret_ref: key }),
    );
    expect(JSON.stringify(input)).not.toContain(key);
  });

  it.each([
    ['a number that is not one', { maxInputTokens: 'lots' }],
    ['no capabilities', { capabilities: [] }],
    ['an unknown capability', { capabilities: ['mind_reading'] }],
    ['an unknown sensitivity', { allowedClasses: ['secret'] }],
    ['an unknown kind', { providerKind: 'anything' }],
  ])('gives the schema %s to refuse', (_name, change) => {
    const input = createInputFromForm(
      form({ ...filled, providerKind: 'openai_compatible', ...change }),
    );
    expect(createModelProfileSchema.safeParse(input).success).toBe(false);
  });
});

describe('the edit form', () => {
  it('makes what the contract accepts, with the version it was drawn from', () => {
    const input = updateInputFromForm(form({ ...filled, version: '4' }));
    expect(updateModelProfileSchema.safeParse(input).success).toBe(true);
    expect(input.expected_version).toBe(4);
  });

  it('cannot change who provides it', () => {
    const input = updateInputFromForm(form({ ...filled, version: '4', providerKind: 'x' }));
    expect(input).not.toHaveProperty('provider_kind');
  });

  it('has no version to offer if it was not sent one, and the schema refuses that', () => {
    expect(updateModelProfileSchema.safeParse(updateInputFromForm(form(filled))).success).toBe(
      false,
    );
  });
});

describe('the key field', () => {
  it('takes a key, with pasted spaces around it removed', () => {
    expect(modelKeySchema.parse('  test-key-abc\n')).toBe('test-key-abc');
  });

  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['a line break, which would add a request header', 'abc\r\nX-Other: 1'],
    ['a space inside', 'abc def'],
    ['more than fits', 'a'.repeat(8193)],
  ])('refuses %s, saying nothing about what was sent', (_name, value) => {
    const parsed = modelKeySchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (value.length > 3) expect(JSON.stringify(parsed.error?.issues)).not.toContain(value);
  });

  it('the route takes exactly a version and a key', () => {
    expect(
      modelCredentialRequestSchema.safeParse({ expected_version: 1, key: 'k', secret_ref: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('prices on the form', () => {
  it.each([
    ['0', 0],
    ['3', 3_000_000],
    ['0.25', 250_000],
    ['12.000001', 12_000_001],
  ])('reads %s dollars exactly', (usd, micros) => {
    expect(usdPerMtokToMicros(usd)).toBe(micros);
    expect(microsToUsd(micros)).toBe(usd);
  });

  it.each(['', 'free', '-1', '1.0000001', '1e3', '1,5'])('refuses %j', (value) => {
    expect(usdPerMtokToMicros(value)).toBeNull();
  });
});

describe('the status words', () => {
  it('cover every status a contract can hold', () => {
    expect(Object.keys(STATUS_LOOK).sort()).toEqual(
      ['active', 'disabled', 'draft', 'probe_failed', 'probing'].sort(),
    );
  });
});

/** Every file of ours under a directory, as text. */
function sources(directory: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) found.push([full, readFileSync(full, 'utf8')]);
    }
  };
  walk(join(repoRoot, directory));
  return found;
}

const WEB = [
  ...sources('apps/web/src/app/o/[organizationId]/settings/models'),
  ...sources('apps/web/src/app/api/v1/organizations/[organizationId]/model-profiles'),
];

describe('what the web tier’s files can reach (FD-23, ADR-024 D5)', () => {
  it('finds its own files, or the rest of this proves nothing', () => {
    expect(WEB.length).toBeGreaterThanOrEqual(10);
  });

  // The capture is the one file that handles a reference, on its way to the service.
  it.each(WEB.filter(([file]) => !file.endsWith('capture.ts')))(
    '%s never names a key reference',
    (_file, source) => {
      expect(source).not.toMatch(/secret_?ref/i);
    },
  );

  it.each(WEB)('%s has no way to a model, a key or the probe’s store', (_file, source) => {
    expect(source).not.toMatch(/@ensemus\/intelligence/);
    expect(source).not.toMatch(/@ensemus\/secrets\/broker/);
    expect(source).not.toMatch(/ai-model-probe-store/);
    expect(source).not.toMatch(/@ensemus\/database\/agent/);
    expect(source).not.toMatch(/@temporalio/);
  });

  it.each(WEB)('%s logs no key and offers none to a browser', (_file, source) => {
    expect(source).not.toMatch(/log\.\w+\([^)]*\bkey\b/);
    expect(source).not.toMatch(/NEXT_PUBLIC_/);
    expect(source).not.toMatch(/defaultValue=\{[^}]*key/i);
  });

  it('takes a key in exactly two places, and each goes through the one capture', () => {
    const callers = WEB.filter(([, source]) => /captureModelKey\(/.test(source)).map(([file]) =>
      file.replaceAll('\\', '/').replace(/.*\/(settings|model-profiles)\//, ''),
    );
    expect(callers.sort()).toEqual([
      '[modelProfileId]/credential/route.ts',
      'models/actions.ts',
      'models/capture.ts',
    ]);
  });

  it('the key field is a password field, never filled in', () => {
    const page = WEB.find(([file]) => file.replaceAll('\\', '/').endsWith('[profileId]/page.tsx'));
    expect(page?.[1]).toMatch(/type="password"\s+name="key"/);
  });

  it('no form or route writes a status of active', () => {
    for (const [, source] of WEB) {
      expect(source).not.toMatch(/status:\s*'active'/);
    }
  });
});
