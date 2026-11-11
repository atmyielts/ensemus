// Egress and tool decisions (ADR-028). Pure: no database, no SDK, no network, and never asks a model
// (ADR-012, enforced by lint). Unknown input denies, and deny beats allow. `@ensemus/domain/policy` stays
// where work access and capabilities live. This package only decides what may leave and what a tool may do.
export * from './types';
export { strongest } from './classification';
export { decideEgress } from './egress';
export { decideAction } from './action';
export { scanForSecrets } from './secret-scan';
export {
  changeNeedsApproval,
  decideConnectionUse,
  recheckSuiteSend,
  resourceIdOf,
  type ConnectionFacts,
  type ConnectionUseDecision,
  type ConnectionUseInput,
  type ResourceFacts,
  type SourceAccess,
  type SuiteSendRecheckInput,
  type SuiteSendRefusal,
} from './suite-access';
