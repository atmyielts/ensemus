// Owned by the skill-verification slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D1, D2.
import type {
  SkillCheckStep,
  SkillVerificationInput,
  SkillVerificationOutcome,
} from './schemas';
import type { SkillActivityDeps } from './skill-deps';

/** On the platform queue. Reading a bundle takes no secret and no runner. */
export function createSkillVerificationActivities(_deps: SkillActivityDeps) {
  return {
    /**
     * Reads the bytes, checks the hash, format, digest, signature and trust, licences and limits, and runs
     * the contract test on every fixture. A declarative package ends here. A package with code gets one
     * queued run per fixture, and the workflow runs those.
     */
    async checkSkillBundle(_input: SkillVerificationInput): Promise<SkillCheckStep> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** After a package's runs settled: compares each output with its fixture, and settles the version. */
    async finishSkillVerification(
      _input: SkillVerificationInput,
    ): Promise<SkillVerificationOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type SkillVerificationActivities = ReturnType<typeof createSkillVerificationActivities>;
