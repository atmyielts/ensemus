// What the skill, sandbox and marketplace Activities are handed. Nothing here reaches the web tier (lint).
// There is deliberately no secret broker, connector or credential in either type: the sandbox worker has
// nothing to give away (ADR-034 D3).
import type { MarketplaceReviewKeys, ObjectStore } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import type { SandboxLimits, SandboxRunnerPort } from '@ensemus/domain/sandbox';

/** On the platform queue, which holds the database and the object store and nothing more. */
export type SkillActivityDeps = {
  database: AppDatabase;
  store: ObjectStore;
  ceilings: SandboxLimits;
  reviewKeys: MarketplaceReviewKeys;
};

/** On the sandbox queue. The runner is the only way out, and it has no route anywhere itself. */
export type SandboxActivityDeps = {
  database: AppDatabase;
  store: ObjectStore;
  runner: SandboxRunnerPort;
  maxConcurrentPerTenant: number;
  /** A passing probe is good for this long before the worker asks again. */
  probeMaxAgeMs: number;
  /** For recording the time of a probe, and in tests. */
  now?: () => Date;
};
