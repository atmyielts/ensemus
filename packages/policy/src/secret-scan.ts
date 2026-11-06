// The pre-send scan (SEC-13, ADR-028 FD-14). An extra signal, and never the only boundary: it matches shapes,
// so it will miss a secret that reads like prose, or one encoded or split across parts. A result holds part
// IDs and codes and no matched text, so it is safe to log and to store. Every pattern here runs in linear
// time on the sizes a part can reach: no nested repeats, and each gap between tokens is bounded.
import type { ContentPart, ScanResult, SecretCode } from './types';

const SHAPES: readonly { code: SecretCode; patterns: readonly RegExp[] }[] = [
  {
    // Any armoured block, and its opening line is enough: a truncated key is still a key.
    code: 'PEM_BLOCK',
    patterns: [/-{5}BEGIN [A-Z0-9 ]{1,64}-{5}/],
  },
  {
    code: 'API_KEY_SHAPE',
    patterns: [
      /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
      /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
      /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,
      /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
      /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/,
      /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{16,}/,
      /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
      /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{20,}/,
      /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/,
      // Whatever its format, a long value given to a name like this is a key.
      /(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?key)["']?\s{0,8}[:=]\s{0,8}["']?[A-Za-z0-9_\-+/=.]{16,}/i,
    ],
  },
  {
    code: 'BEARER_TOKEN_SHAPE',
    patterns: [
      /(?<![A-Za-z0-9])bearer\s{1,8}[A-Za-z0-9\-._~+/]{20,}/i,
      /(?<![A-Za-z0-9])basic\s{1,8}[A-Za-z0-9+/]{20,}={0,2}/i,
      // A JSON Web Token: two base64 JSON objects and a signature. The wider look-behind allows one start per
      // run of these characters, which keeps this linear, since each run has to end in a dot.
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    ],
  },
  {
    code: 'CLOUD_KEY_SHAPE',
    patterns: [
      /(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}(?![A-Z0-9])/,
      /aws_secret_access_key["']?\s{0,8}[:=]/i,
      /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
      /"type"\s{0,8}:\s{0,8}"service_account"/,
      /"private_key_id"\s{0,8}:/,
      /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/,
      /SharedAccessSignature=/,
    ],
  },
];

/** Marks with no width of their own, which would otherwise hide a key from every pattern above. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

const normalise = (text: string) => text.normalize('NFKC').replace(INVISIBLE, '');

export function scanForSecrets(
  parts: readonly ContentPart[],
  canaries: readonly string[] = [],
): ScanResult {
  // An empty canary would match every part, and tell us nothing about any of them.
  const wanted = canaries
    .filter((canary) => typeof canary === 'string' && canary.trim().length > 0)
    .map((canary) => normalise(canary).toLowerCase());

  const hits: { partId: string; code: SecretCode }[] = [];
  for (const part of parts) {
    // A part that cannot be read cannot be cleared, so it counts as holding a key.
    if (typeof part.text !== 'string') {
      hits.push({ partId: part.id, code: 'API_KEY_SHAPE' });
      continue;
    }
    const text = normalise(part.text);
    for (const { code, patterns } of SHAPES) {
      if (patterns.some((pattern) => pattern.test(text))) hits.push({ partId: part.id, code });
    }
    const folded = text.toLowerCase();
    if (wanted.some((canary) => folded.includes(canary))) {
      hits.push({ partId: part.id, code: 'TENANT_CANARY' });
    }
  }
  return { hits };
}
