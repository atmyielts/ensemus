import { strongestClassification, type AiClassification } from '@ensemus/domain/ai';

/** Mixing inherits the strongest class. One rule, in one place, so workflow code can use it too. */
export function strongest(a: AiClassification, b: AiClassification): AiClassification {
  return strongestClassification(a, b);
}
