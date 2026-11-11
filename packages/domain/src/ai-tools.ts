// The tool list is code, not a table (ADR-028 FD-18). A tool not named here does not exist, and no
// `secrets.*` tool exists at all. Argument schemas are in @ensemus/contracts/ai-tools.
//
// A tool that works through a connection carries its `connection` rule (ADR-038 D6): which connector types,
// which scopes on each, whose connection, what the source's own ACL must grant, and how a change is
// reconciled. The gateway decides from that rule alone, so a new suite tool is a new entry here and in
// the contracts, and never a new branch in the gateway.
import { EMAIL_SEND_CONNECTION, SUITE_CONNECTION_RULES, type ConnectionRule } from './suite-tools';

export type {
  ConnectionRule,
  SuiteToolId,
  ToolBinding,
  ToolCapability,
  ToolConnectorType,
  ToolOwnerRule,
  ToolReconcileKind,
} from './suite-tools';
export {
  isSuiteConnectorType,
  isSuiteRule,
  SUITE_CONNECTION_RULES,
  SUITE_TOOL_CONNECTOR_TYPES,
  TOOL_CONNECTOR_TYPES,
} from './suite-tools';

export const TOOL_CLASSES = ['read_only', 'draft_only', 'external_write', 'delegation'] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export type ToolManifest = {
  id: string;
  version: string;
  class: ToolClass;
  /** External effects always ask a person. An agent's manifest cannot turn this off. */
  requiresApproval: boolean;
  /** Set for a tool that works through a connection. Its arguments then carry `connection_id`. */
  connection?: ConnectionRule;
};

const suite = <Id extends keyof typeof SUITE_CONNECTION_RULES>(
  id: Id,
  toolClass: 'read_only' | 'draft_only' | 'external_write',
) =>
  ({
    id,
    version: '1',
    class: toolClass,
    // Every change outside asks a person. A draft in the person's own mailbox is not a change: it can be
    // deleted, it reaches nobody, and it still gets an intent and a receipt (ADR-038 D6).
    requiresApproval: toolClass === 'external_write',
    connection: SUITE_CONNECTION_RULES[id] as ConnectionRule,
  }) as const;

export const TOOL_MANIFESTS = [
  { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.read_text', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.draft.create', version: '1', class: 'draft_only', requiresApproval: false },
  {
    id: 'email.send',
    version: '1',
    class: 'external_write',
    requiresApproval: true,
    connection: EMAIL_SEND_CONNECTION,
  },
  { id: 'agent.delegate', version: '1', class: 'delegation', requiresApproval: false },
  // Google Workspace.
  suite('gmail.search', 'read_only'),
  suite('gmail.read_thread', 'read_only'),
  suite('gmail.create_draft', 'draft_only'),
  suite('gmail.send', 'external_write'),
  suite('drive.search', 'read_only'),
  suite('drive.create_file', 'external_write'),
  suite('docs.read', 'read_only'),
  suite('docs.edit', 'external_write'),
  suite('sheets.read_range', 'read_only'),
  suite('sheets.write_range', 'external_write'),
  // Both providers.
  suite('calendar.list_events', 'read_only'),
  suite('calendar.create_event', 'external_write'),
  suite('calendar.update_event', 'external_write'),
  // Microsoft 365.
  suite('outlook.search', 'read_only'),
  suite('outlook.read_thread', 'read_only'),
  suite('outlook.create_draft', 'draft_only'),
  suite('outlook.send', 'external_write'),
  suite('onedrive.search', 'read_only'),
  suite('onedrive.create_file', 'external_write'),
  suite('word.read', 'read_only'),
  suite('excel.read_range', 'read_only'),
  suite('excel.write_range', 'external_write'),
  suite('teams.post_message', 'external_write'),
] as const satisfies readonly ToolManifest[];

export type ToolId = (typeof TOOL_MANIFESTS)[number]['id'];

export const TOOL_IDS: readonly ToolId[] = TOOL_MANIFESTS.map((tool) => tool.id);

export function toolManifest(id: string): ToolManifest | undefined {
  return (TOOL_MANIFESTS as readonly ToolManifest[]).find((tool) => tool.id === id);
}

/** A tool that changes something through a connection, and so becomes an ADR-027 intent. */
export const isActionTool = (manifest: ToolManifest | undefined): manifest is ToolManifest =>
  manifest !== undefined &&
  manifest.connection !== undefined &&
  (manifest.class === 'external_write' || manifest.class === 'draft_only');

/** Tools a connector of this type may be asked to perform. A connector's manifest lists the same. */
export const actionToolsFor = (connectorType: string): readonly string[] =>
  (TOOL_MANIFESTS as readonly ToolManifest[])
    .filter(
      (tool) =>
        isActionTool(tool) &&
        (tool.connection?.connectorTypes as readonly string[]).includes(connectorType),
    )
    .map((tool) => tool.id);

/** A name a manifest may never allow, even as a future tool: lint at publish refuses these. */
export const FORBIDDEN_TOOL_PREFIXES = ['secrets.', 'model.', 'budget.', 'policy.', 'grant.'];
