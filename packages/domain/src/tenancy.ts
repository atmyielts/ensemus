// What a deployment is, and what can honestly be said about its isolation (ADR-035 D5). Pure. Which tiers
// are sold, at what price and with what service level are owner decisions and appear nowhere in this code.

export const TENANCY_TIERS = ['shared', 'dedicated'] as const;
export type TenancyTier = (typeof TENANCY_TIERS)[number];

/** What a dedicated deployment has to keep apart from every other one. */
export const ISOLATION_ASPECTS = [
  'database',
  'network',
  'worker_pool',
  'temporal_namespace',
  'object_store',
  'backups',
  'embeddings',
  'telemetry',
  'key_encryption_key',
] as const;
export type IsolationAspect = (typeof ISOLATION_ASPECTS)[number];

/** A deployment's own probes can prove these. The rest it can only be told about. */
export const PROBED_ISOLATION_ASPECTS: readonly IsolationAspect[] = [
  'database',
  'network',
  'worker_pool',
  'temporal_namespace',
  'object_store',
];

export const ISOLATION_RESULTS = ['passed', 'failed', 'declared'] as const;
export type IsolationResult = (typeof ISOLATION_RESULTS)[number];

export type IsolationRecord = {
  aspect: IsolationAspect;
  result: IsolationResult;
  code: string | null;
  releaseVersion: string;
  checkedAt: Date;
};

export type IsolationAspectPosture = {
  aspect: IsolationAspect;
  /** `unchecked` when nothing recorded it. `stale` when the last check was on another release. */
  state: 'passed' | 'failed' | 'declared' | 'unchecked' | 'stale';
  code: string | null;
  checkedAt: Date | null;
};

export type IsolationPosture = {
  tier: TenancyTier;
  aspects: readonly IsolationAspectPosture[];
  /**
   * True only when every aspect a probe can prove passed on this release, and every other one is at least
   * declared. A shared deployment is never `isolated`, and nothing else in the product may say so.
   */
  isolated: boolean;
};

/** Reports what was found and adds nothing to it. The latest record of each aspect wins. */
export function isolationPosture(
  tier: TenancyTier,
  records: readonly IsolationRecord[],
  releaseVersion: string | null,
): IsolationPosture {
  const aspects = ISOLATION_ASPECTS.map((aspect): IsolationAspectPosture => {
    const latest = records
      .filter((record) => record.aspect === aspect)
      .reduce<IsolationRecord | null>(
        (best, record) =>
          best === null || record.checkedAt.getTime() > best.checkedAt.getTime() ? record : best,
        null,
      );
    if (!latest) return { aspect, state: 'unchecked', code: null, checkedAt: null };
    return {
      aspect,
      state: latest.releaseVersion === releaseVersion ? latest.result : 'stale',
      code: latest.code,
      checkedAt: latest.checkedAt,
    };
  });
  const satisfied = (posture: IsolationAspectPosture) =>
    posture.state === 'passed' ||
    (posture.state === 'declared' && !PROBED_ISOLATION_ASPECTS.includes(posture.aspect));
  return { tier, aspects, isolated: tier === 'dedicated' && aspects.every(satisfied) };
}

/** Codes an isolation probe can report. Never a message: no host or name goes in the record. */
export const ISOLATION_CODES = [
  'FOREIGN_ORGANIZATION_PRESENT',
  'FOREIGN_ENDPOINT_REACHABLE',
  'NAMESPACE_SHARED',
  'BUCKET_SHARED',
  'NOT_DECLARED',
  'NO_FOREIGN_ENDPOINTS_GIVEN',
  'PROBE_FAILED',
] as const;
export type IsolationCode = (typeof ISOLATION_CODES)[number];
