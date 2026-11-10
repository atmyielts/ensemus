// SEC-01. What a tool may do. The model is not an input here, so nothing it says can change the answer.
import { CLASSIFICATIONS, type AiClassification } from '@ensemus/domain/ai';
import { TOOL_MANIFESTS } from '@ensemus/domain/ai-tools';
import { describe, expect, it } from 'vitest';
import { decideAction } from './action';
import type { ActionInput } from './types';

function input(overrides: Partial<ActionInput> = {}): ActionInput {
  return {
    toolId: 'work.read',
    toolClass: 'read_only',
    allow: ['work.read', 'email.send', 'artifact.draft.create', 'agent.delegate'],
    deny: [],
    delegated: ['work.read', 'email.send', 'artifact.draft.create', 'agent.delegate'],
    dataClass: 'internal',
    destructive: false,
    requiresApproval: false,
    ...overrides,
  };
}

const email = { toolId: 'email.send', toolClass: 'external_write' as const };

describe('decideAction', () => {
  it('allows a granted, read-only tool', () => {
    expect(decideAction(input())).toEqual({ decision: 'allow', reasonCode: 'ALLOWED' });
  });

  it('asks a person before an outside effect', () => {
    expect(decideAction(input(email))).toEqual({
      decision: 'require_approval',
      reasonCode: 'APPROVAL_REQUIRED',
    });
  });

  it('asks a person when the manifest says so, even if the caller says not to', () => {
    expect(decideAction(input({ ...email, requiresApproval: false })).decision).toBe(
      'require_approval',
    );
  });

  it('asks a person when the caller says so, even if the manifest does not need it', () => {
    expect(decideAction(input({ requiresApproval: true })).decision).toBe('require_approval');
  });

  describe('deny beats require_approval beats allow', () => {
    it('deny beats allow', () => {
      expect(decideAction(input({ deny: ['work.read'] }))).toEqual({
        decision: 'deny',
        reasonCode: 'TOOL_DENIED_BY_SPEC',
      });
    });

    it('deny beats require_approval', () => {
      expect(decideAction(input({ ...email, deny: ['email.send'] }))).toEqual({
        decision: 'deny',
        reasonCode: 'TOOL_DENIED_BY_SPEC',
      });
    });

    it('a destructive flag beats everything else that would allow', () => {
      expect(decideAction(input({ destructive: true }))).toEqual({
        decision: 'deny',
        reasonCode: 'DESTRUCTIVE_DENIED',
      });
      expect(decideAction(input({ ...email, destructive: true })).decision).toBe('deny');
    });

    it('a denied restricted send is not offered for approval: a person cannot approve it past policy', () => {
      expect(decideAction(input({ ...email, dataClass: 'restricted' }))).toEqual({
        decision: 'deny',
        reasonCode: 'CLASS_DENIED',
      });
    });
  });

  describe('grants', () => {
    it('refuses a tool the version does not allow', () => {
      expect(decideAction(input({ allow: [] }))).toEqual({
        decision: 'deny',
        reasonCode: 'TOOL_NOT_GRANTED',
      });
    });

    it('refuses a tool this run was not delegated, though the version allows it', () => {
      expect(decideAction(input({ delegated: [] }))).toEqual({
        decision: 'deny',
        reasonCode: 'TOOL_NOT_GRANTED',
      });
    });

    it('takes a grant as an exact name, so no wildcard widens it', () => {
      for (const allow of [['*'], ['work.*'], ['work'], ['WORK.READ']]) {
        expect(decideAction(input({ allow })).decision).toBe('deny');
      }
    });
  });

  describe('tools that do not exist', () => {
    it('refuses a tool a model invented, even if somebody listed it', () => {
      const invented = {
        toolId: 'shell.exec',
        toolClass: 'read_only' as const,
        allow: ['shell.exec'],
        delegated: ['shell.exec'],
      };
      expect(decideAction(input(invented))).toEqual({
        decision: 'deny',
        reasonCode: 'TOOL_UNKNOWN',
      });
    });

    it('refuses every forbidden prefix, even when granted', () => {
      for (const toolId of [
        'secrets.read',
        'model.switch',
        'budget.raise',
        'policy.set',
        'grant.add',
      ]) {
        const decision = decideAction(
          input({ toolId, toolClass: 'read_only', allow: [toolId], delegated: [toolId] }),
        );
        expect(decision, toolId).toEqual({ decision: 'deny', reasonCode: 'TOOL_UNKNOWN' });
      }
    });

    it('refuses a tool with no class', () => {
      expect(decideAction(input({ toolClass: null })).reasonCode).toBe('TOOL_UNKNOWN');
    });

    it('refuses a class that disagrees with the manifest, so a send cannot pose as a read', () => {
      expect(decideAction(input({ toolId: 'email.send', toolClass: 'read_only' }))).toEqual({
        decision: 'deny',
        reasonCode: 'UNKNOWN_INPUT',
      });
    });
  });

  describe('unknown input denies', () => {
    for (const [name, broken] of Object.entries({
      'no tool': { toolId: '' },
      'a tool that is not text': { toolId: 7 },
      'an unknown class of data': { dataClass: 'top-secret' },
      'an allow list that is not a list': { allow: 'work.read' },
      'a deny list that is not a list': { deny: null },
      'a delegated list that is not a list': { delegated: undefined },
      'a destructive flag that is only truthy': { destructive: 'no' },
      'an approval flag that is only falsy': { requiresApproval: 0 },
    })) {
      it(name, () => {
        const decision = decideAction({ ...input(), ...broken } as unknown as ActionInput);
        expect(decision).toEqual({ decision: 'deny', reasonCode: 'UNKNOWN_INPUT' });
      });
    }

    it('nothing at all', () => {
      expect(decideAction(null as unknown as ActionInput).decision).toBe('deny');
    });
  });

  it('never allows anything outside the manifest, at any class', () => {
    for (const dataClass of CLASSIFICATIONS as readonly AiClassification[]) {
      for (const tool of TOOL_MANIFESTS) {
        const granted = decideAction(
          input({
            toolId: tool.id,
            toolClass: tool.class,
            allow: [tool.id],
            delegated: [tool.id],
            dataClass,
          }),
        );
        if (tool.requiresApproval) expect(granted.decision).not.toBe('allow');
        const ungranted = decideAction(
          input({ toolId: tool.id, toolClass: tool.class, allow: [], delegated: [], dataClass }),
        );
        expect(ungranted.decision).toBe('deny');
      }
    }
  });
});
