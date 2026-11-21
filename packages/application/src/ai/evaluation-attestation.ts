// Owned by the agents slice (AGENT-16, threat SEC-007). Publishing used to take an uploaded evaluation
// report on trust: anyone with `agent.publish` could type `passed: true` and get a version. A report now
// counts only when an Ed25519 key that the web tier never holds has signed it.
//
// Why a signature and not a report the server computes itself: a server-side evaluation needs an
// evaluation workflow on the agent worker, a table only `ensemus_agent` writes (FD-4) and a suite the
// worker can run against a tenant's own model. None of those exist yet, and building them would put new
// Temporal history into the replay corpus. A signature gives the same property the table would, that web
// can check a report and never forge one, using what exists today: the harness in CI, and later the
// worker, sign with a private key; web holds only public keys, each with an id so a key can be rotated.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import {
  evaluationReportV2Schema,
  signedEvaluationReportSchema,
  type EvaluationReportV2,
  type SignedEvaluationReport,
} from '@ensemus/contracts/ai';
import { canonicalJson } from '@ensemus/domain/approval';
import { AppError } from '../errors';

/**
 * Prefixed to what is signed, so a signature made for a report can never be replayed as a signature over
 * anything else the same key might one day sign, and a v3 report needs a new prefix and so a new decision.
 */
export const EVALUATION_SIGNATURE_CONTEXT = 'ensemus.evaluation-report.v2\n';

/** How far ahead of this server's clock a report may say it was made. Clocks drift; minutes, not hours. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The public keys a report may be signed with, by key id, and how old a report may be. */
export type EvaluationTrust = {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly maxAgeMs: number;
};

/** What a deployment that names no key trusts: nothing. Every report is refused, never waved through. */
export const NO_EVALUATION_TRUST: EvaluationTrust = { keys: new Map(), maxAgeMs: 0 };

export type EvaluationSigner = { readonly keyId: string; readonly privateKey: KeyObject };

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RAW_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

const signedBytes = (report: EvaluationReportV2) =>
  Buffer.from(`${EVALUATION_SIGNATURE_CONTEXT}${canonicalJson(report)}`, 'utf8');

/**
 * Builds the trust a publish checks against, from the operator's settings. A key that is not an Ed25519
 * public key is a configuration error, so a typo cannot quietly leave a deployment trusting nothing.
 */
export function evaluationTrust(settings: {
  publicKeys: readonly { keyId: string; publicKey: string }[];
  maxAgeHours: number;
}): EvaluationTrust {
  if (!Number.isSafeInteger(settings.maxAgeHours) || settings.maxAgeHours < 1) {
    throw new Error('EVALUATION_TRUST_INVALID_MAX_AGE');
  }
  const keys = new Map<string, KeyObject>();
  for (const { keyId, publicKey } of settings.publicKeys) {
    if (!KEY_ID.test(keyId) || !RAW_PUBLIC_KEY.test(publicKey) || keys.has(keyId)) {
      throw new Error('EVALUATION_TRUST_INVALID_KEY');
    }
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
    keys.set(keyId, key);
  }
  return { keys, maxAgeMs: settings.maxAgeHours * 60 * 60 * 1000 };
}

/** The signing side, for the harness in CI and the agent worker. A key of any other kind is refused. */
export function evaluationSigner(settings: {
  keyId: string;
  privateKeyPem: string;
}): EvaluationSigner {
  if (!KEY_ID.test(settings.keyId)) throw new Error('EVALUATION_SIGNER_INVALID_KEY_ID');
  const privateKey = createPrivateKey(settings.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('EVALUATION_SIGNER_NOT_ED25519');
  return { keyId: settings.keyId, privateKey };
}

/** The raw public key an operator puts in ENSEMUS_EVALUATION_PUBLIC_KEYS for this signer. */
export const publicKeyOf = (signer: EvaluationSigner): string => {
  const jwk = createPublicKey(signer.privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('EVALUATION_SIGNER_NOT_ED25519');
  return jwk.x;
};

/**
 * Whether a report agrees with itself. A valid signature over a report whose totals do not add up means a
 * broken harness or a key used by hand, and neither is evidence. Codes only, never the report's content.
 */
export function evaluationReportProblems(report: EvaluationReportV2): string[] {
  const problems: string[] = [];
  const results = report.case_results;
  if (results.length !== report.cases) problems.push('CASE_COUNT_MISMATCH');
  if (new Set(results.map((item) => item.id)).size !== results.length) {
    problems.push('DUPLICATE_CASE');
  }
  // The same expression the harness uses, so equal inputs give the identical float.
  const passRate = results.filter((item) => item.passed).length / results.length;
  if (passRate !== report.pass_rate) problems.push('PASS_RATE_MISMATCH');
  const cost = results.reduce((sum, item) => sum + item.cost_micros, 0);
  if (!Number.isSafeInteger(cost) || cost !== report.cost_micros) problems.push('COST_MISMATCH');
  const latency = results.reduce((sum, item) => sum + item.latency_ms, 0);
  if (!Number.isSafeInteger(latency) || latency !== report.latency_ms) {
    problems.push('LATENCY_MISMATCH');
  }
  if (report.passed && results.some((item) => item.critical && !item.passed)) {
    problems.push('PASSED_WITH_CRITICAL_FAILURE');
  }
  return problems;
}

/**
 * Signs a report the harness made. It refuses one that does not agree with itself, so the only reports
 * that ever carry a signature are ones the server would also find consistent.
 */
export function signEvaluationReport(
  report: EvaluationReportV2,
  signer: EvaluationSigner,
): SignedEvaluationReport {
  const parsed = evaluationReportV2Schema.parse(report);
  const problems = evaluationReportProblems(parsed);
  if (problems.length > 0) throw new Error(`EVALUATION_REPORT_INCONSISTENT:${problems.join(',')}`);
  return {
    report: parsed,
    signature: {
      algorithm: 'ed25519',
      key_id: signer.keyId,
      value: sign(null, signedBytes(parsed), signer.privateKey).toString('base64url'),
    },
  };
}

/**
 * Checks a presented report and hands back the report alone. The signature is checked before anything the
 * report says is read, so a forged one learns nothing from which refusal it gets, and an unknown key id, a
 * wrong key and a changed byte all get the same code.
 */
export function verifyEvaluationAttestation(
  raw: unknown,
  trust: EvaluationTrust,
  now: Date,
): EvaluationReportV2 {
  const parsed = signedEvaluationReportSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('AGENT_EVALUATION_UNVERIFIED');
  const { report, signature } = parsed.data;
  const key = trust.keys.get(signature.key_id);
  if (!key) throw new AppError('AGENT_EVALUATION_UNVERIFIED');
  const genuine = verify(null, signedBytes(report), key, Buffer.from(signature.value, 'base64url'));
  if (!genuine) throw new AppError('AGENT_EVALUATION_UNVERIFIED');
  if (evaluationReportProblems(report).length > 0)
    throw new AppError('AGENT_EVALUATION_UNVERIFIED');
  const issued = Date.parse(report.issued_at);
  const age = now.getTime() - issued;
  // Too old, or from the future: either way the report says nothing about the code and policy of today.
  if (!Number.isFinite(issued) || age > trust.maxAgeMs || age < -MAX_CLOCK_SKEW_MS) {
    throw new AppError('AGENT_EVALUATION_STALE');
  }
  return report;
}
