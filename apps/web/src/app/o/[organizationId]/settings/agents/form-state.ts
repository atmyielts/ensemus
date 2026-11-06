// What the publish form's Server Action hands back. What was typed comes back with a refusal, so a refused
// publish never loses a person's work. Everything else here is a code or a name from our own schema.
import type { SpecLintCode } from '@ensemus/policy/agent-spec-lint';

export type PublishFormState = {
  code?: string;
  lintCodes?: readonly SpecLintCode[];
  fields?: readonly string[];
  values?: { manifest: string; report: string };
  published?: { versionNumber: number };
};
