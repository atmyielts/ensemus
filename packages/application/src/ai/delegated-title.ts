// A trusted result-write transform receipt, never a hash supplied by model/tool arguments.
import { createHash } from 'node:crypto';
import { agentDelegateArgsSchema } from '@ensemus/contracts/ai-tools';
import { canonicalJson } from '@ensemus/domain/approval';
import { workTitleInput } from '../work-title';

export const DELEGATED_TITLE_TRANSFORM = 'work-title-v1';

/** Store only this digest/version beside the actual immutable paid proposal. SQL later hashes the
 * copied Work bytes; it never guesses whether btrim agrees with ECMAScript Unicode trim. */
export function delegatedBodyProofFromProposal(actualArguments: unknown) {
  const argumentsResult = agentDelegateArgsSchema.safeParse(actualArguments);
  if (!argumentsResult.success) return null;
  const title = workTitleInput.safeParse(argumentsResult.data.title);
  if (!title.success) return null;
  return {
    transformVersion: DELEGATED_TITLE_TRANSFORM,
    derivedBodySha256: createHash('sha256')
      .update(canonicalJson({ objective: null, title: title.data }))
      .digest('hex'),
  };
}
