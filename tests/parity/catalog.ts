// COMM-06: every scenario the parity gate asks for. A scenario missing here cannot pass the gate, and one
// listed here that never runs leaves the gate at "not proven". So this list is the suite's real scope,
// and it is fixed by the M9P foundation (docs/06-delivery/m9p-slices.md).
// The gate imports this straight from Node, so it holds data and a type-only import.
import type { CommercialMode, ParityScenarioSpec } from './rules';

const ALL: readonly CommercialMode[] = ['cloud', 'byom', 'sovereign'];
const CUSTOMER_MODELS: readonly CommercialMode[] = ['byom', 'sovereign'];

const shared = (
  id: string,
  file: string,
  title: string,
  tickets: readonly string[],
  qa: readonly string[] = [],
  modes: readonly CommercialMode[] = ALL,
): ParityScenarioSpec => ({ id, title, kind: 'shared', modes, file, tickets, qa });

const contract = (
  id: string,
  file: string,
  title: string,
  dimension: string,
  tickets: readonly string[],
  qa: readonly string[] = [],
  modes: readonly CommercialMode[] = ALL,
): ParityScenarioSpec => ({
  id,
  title,
  kind: 'mode_contract',
  modes,
  file,
  tickets,
  qa,
  dimension,
});

export const PARITY_CATALOG: readonly ParityScenarioSpec[] = [
  // Slice parity-work: core Work Unit semantics, through the product's own forms and API.
  shared('PAR-WORK-01', 'work', 'A Work Unit moves through the same states', ['WORK-01']),
  shared('PAR-WORK-02', 'work', 'A stale edit is refused the same way', ['WORK-01']),
  shared('PAR-WORK-03', 'work', 'A dependency cycle is refused', ['WORK-02'], ['QA-004']),
  shared('PAR-WORK-04', 'work', 'Completing without evidence is refused', ['WORK-04'], ['QA-006']),
  shared('PAR-WORK-05', 'work', 'One accountable owner; delegates stay in scope', ['WORK-03']),
  shared('PAR-WORK-06', 'work', 'An approval binds the exact action, and expires', ['WORK-05']),
  shared(
    'PAR-WORK-07',
    'work',
    'A paused approval survives a worker restart',
    ['WORK-07'],
    ['QA-014'],
  ),
  shared('PAR-WORK-08', 'work', 'Approvers are told through a channel that works offline', [
    'UX-17',
  ]),
  shared('PAR-WORK-09', 'work', 'The public API has one error shape and one contract', ['API-12']),
  shared('PAR-WORK-10', 'work', 'Reconnecting shows durable state from another replica', [
    'API-13',
  ]),
  shared('PAR-WORK-11', 'work', 'Deleted content stays gone', ['LIFE-01']),

  // Slice parity-boundary: the boundaries no plan or mode may weaken (05-commercial-modes.md).
  shared('PAR-TEN-01', 'boundary', "Another tenant's ID is not found", ['FOUND-03'], ['QA-001']),
  shared('PAR-TEN-02', 'boundary', 'Same-named clients stay apart', ['UX-16'], ['QA-002']),
  shared(
    'PAR-TEN-03',
    'boundary',
    'Switching organization mid-stream shows nothing of the last',
    ['API-13'],
    ['QA-003'],
  ),
  shared(
    'PAR-TEN-04',
    'boundary',
    'A forged cross-tenant Server Action is refused',
    ['API-11'],
    ['NEXT-01'],
  ),
  shared('PAR-TEN-05', 'boundary', 'An invitation grants only the stated organization', ['ID-02']),
  shared('PAR-TEN-06', 'boundary', 'People and teams are filtered by permission', ['UX-15']),
  shared(
    'PAR-SEC-01',
    'boundary',
    'A secret canary reaches no page, payload or log',
    ['SEC-10'],
    ['NEXT-02', 'QA-018'],
  ),
  shared(
    'PAR-SEC-02',
    'boundary',
    'A revoked permission is refused on a warm cache',
    ['SEC-12'],
    ['NEXT-03'],
  ),
  shared('PAR-SEC-03', 'boundary', 'The web tier has no path to Temporal', ['ASSUR-01']),
  shared(
    'PAR-SEC-04',
    'boundary',
    'Restricted data is refused before any provider call',
    ['SEC-01'],
    ['QA-010', 'QA-011'],
  ),
  shared(
    'PAR-ACT-01',
    'boundary',
    'A changed recipient voids the approval',
    ['WORK-08'],
    ['QA-007'],
  ),
  shared(
    'PAR-ACT-02',
    'boundary',
    'A send that times out has one effect, and says unknown',
    ['WORK-08'],
    ['QA-008', 'AI-TS-01'],
  ),
  shared(
    'PAR-ACT-03',
    'boundary',
    'A replayed webhook does nothing twice',
    ['CONNECT-02'],
    ['QA-019'],
  ),

  // Slice parity-modes: what runs on models and data, then the differences the contract allows.
  shared('PAR-AGENT-01', 'modes', 'One agent manifest format, accepted and refused alike', [
    'AGENT-01',
  ]),
  shared('PAR-AGENT-02', 'modes', 'A run over budget stops safely', ['AGENT-02'], ['QA-012']),
  shared(
    'PAR-AGENT-03',
    'modes',
    'A child agent cannot exceed its parent',
    ['AGENT-05'],
    ['QA-013'],
  ),
  shared('PAR-AGENT-04', 'modes', 'The emergency stop stops queued and running work', ['SEC-06']),
  shared(
    'PAR-KNOW-01',
    'modes',
    'A revoked source stops being served at once',
    ['KNOW-05'],
    ['QA-015'],
  ),
  shared('PAR-KNOW-02', 'modes', 'A fact in conflict stays disputed', ['KNOW-04'], ['QA-016']),
  shared(
    'PAR-PORT-01',
    'modes',
    'Export then import keeps records and relationships',
    ['COMM-05'],
    ['QA-023'],
  ),
  shared('PAR-PORT-02', 'modes', 'An export holds no raw credential', ['COMM-05'], ['QA-024']),
  shared(
    'PAR-MODEL-01',
    'modes',
    'An unavailable customer provider fails closed',
    ['COMM-02', 'MODEL-03'],
    ['QA-009', 'AI-TS-02'],
    CUSTOMER_MODELS,
  ),
  shared(
    'PAR-MODEL-02',
    'modes',
    'A changed customer key is never shown, and the call is safe',
    ['SEC-11'],
    ['BYOM-TS-01'],
    CUSTOMER_MODELS,
  ),
  contract(
    'PAR-MODE-01',
    'modes',
    'Each mode states who is responsible for the data',
    'responsibility_statement',
    ['ID-01'],
  ),
  contract('PAR-MODE-02', 'modes', 'Models come from the supplier the mode says', 'model_supply', [
    'MODEL-03',
    'COMM-02',
  ]),
  contract(
    'PAR-MODE-03',
    'modes',
    'Inference is billed by whom the mode says, and never twice',
    'inference_billing',
    ['MODEL-04'],
    ['QA-027'],
  ),
  contract(
    'PAR-MODE-04',
    'modes',
    'Used-up Cloud credits pause work, with no surprise charge',
    'inference_billing',
    ['COMM-01', 'BILL-05'],
    ['QA-026'],
    ['cloud'],
  ),
  contract(
    'PAR-MODE-05',
    'modes',
    'Sovereign operates with outside names unreachable',
    'offline_operation',
    ['COMM-04', 'PLAT-16'],
    ['QA-020', 'SOV-TS-01'],
    ['sovereign'],
  ),
  contract(
    'PAR-MODE-06',
    'modes',
    'Sovereign keeps working after maintenance lapses',
    'maintenance_lapse',
    ['COMM-03', 'OPS-11'],
    ['QA-021', 'SOV-TS-02'],
    ['sovereign'],
  ),
  contract(
    'PAR-MODE-07',
    'modes',
    'A Sovereign license verifies with no vendor contact',
    'license_validation',
    ['COMM-03'],
    [],
    ['sovereign'],
  ),
  contract(
    'PAR-MODE-08',
    'modes',
    'A tampered or unsigned bundle is refused offline',
    'updates',
    ['COMM-04', 'SOV-03'],
    ['QA-022', 'DEP-TS-02'],
    ['sovereign'],
  ),
  contract(
    'PAR-MODE-09',
    'modes',
    'Sovereign sends nothing unless told to',
    'vendor_telemetry',
    ['SEC-05'],
    [],
    ['sovereign'],
  ),
];
