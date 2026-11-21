// AGENT-02: what a long run may leave out to fit a model, and the fixed words of a repair turn.
import { describe, expect, it } from 'vitest';
import { MALFORMATIONS, type ContextMessage } from '../types';
import { compactToFit, composeMessages, repairMessage } from './compaction';

const part = (role: ContextMessage['role'], partId: string): ContextMessage => ({
  role,
  partId,
  text: `${partId} text`,
  classification: 'internal',
});

const turn = [
  part('policy', 'policy'),
  part('task', 'work:w1'),
  part('evidence', 'artifact:a'),
  part('evidence', 'artifact:b'),
  part('tool_output', 'step:1:completion:0'),
  part('tool_output', 'step:1:tool_output:1'),
  part('tool_output', 'step:4:tool_output:2'),
  part('tool_output', 'step:4:tool_args:3'),
];

/** Records the order things were left out in, and fits once `need` have gone. */
function dropsUntil(need: number) {
  const order: number[][] = [];
  const fits = (dropped: ReadonlySet<number>) => {
    order.push([...dropped]);
    return dropped.size >= need;
  };
  return { order, fits };
}

describe('compactToFit', () => {
  it('leaves nothing out when everything fits', () => {
    expect(compactToFit(turn, () => true)).toEqual(new Set());
  });

  it('drops older steps first, oldest first, then evidence last first', () => {
    const { fits } = dropsUntil(4);
    expect([...compactToFit(turn, fits)!]).toEqual([4, 5, 3, 2]);
  });

  it('never drops the policy, the task or any part of the newest step', () => {
    const left = compactToFit(turn, () => false);
    expect(left).toBeNull();
    const { order } = dropsUntil(99);
    compactToFit(turn, (dropped) => {
      order.push([...dropped]);
      return false;
    });
    const everDropped = new Set(order.flat());
    for (const kept of [0, 1, 6, 7]) expect(everDropped.has(kept)).toBe(false);
  });

  it('keeps the last tool output when step numbers cannot be read', () => {
    const odd = [part('policy', 'policy'), part('tool_output', 'x'), part('tool_output', 'y')];
    const { fits } = dropsUntil(1);
    expect([...compactToFit(odd, fits)!]).toEqual([1]);
    expect(compactToFit(odd, (dropped) => dropped.has(2))).toBeNull();
  });

  it('starts from what an earlier pass already left out', () => {
    const { fits } = dropsUntil(2);
    expect([...compactToFit(turn, fits, new Set([4]))!]).toEqual([4, 5]);
  });
});

describe('composeMessages', () => {
  it('adds a notice that counts what went, and puts a correction last', () => {
    const correction = repairMessage('empty_output', 'internal');
    const sent = composeMessages(turn, new Set([4, 5]), [correction], 'internal');
    expect(sent.map((each) => each.partId)).toEqual([
      'policy',
      'work:w1',
      'artifact:a',
      'artifact:b',
      'step:4:tool_output:2',
      'step:4:tool_args:3',
      'compaction',
      'repair:empty_output',
    ]);
    expect(sent.at(-2)!.text).toContain('2 earlier parts');
    expect(sent.at(-2)!.role).toBe('task');
  });

  it('adds no notice when nothing was left out', () => {
    expect(composeMessages(turn, new Set(), [], 'internal')).toEqual(turn);
  });
});

describe('repairMessage', () => {
  it.each(MALFORMATIONS)('has a fixed, provider-neutral correction for %s', (malformation) => {
    const message = repairMessage(malformation, 'confidential');
    expect(message).toMatchObject({
      role: 'task',
      partId: `repair:${malformation}`,
      classification: 'confidential',
    });
    expect(message.text).toMatch(/^(Your previous reply|The arguments of your previous tool call)/);
    expect(message.text).not.toMatch(/openai|anthropic|gemini|claude|gpt/i);
  });
});
