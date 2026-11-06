// What keeps a second form from being sent with a version the first is about to move. Run here, because
// the web app has no test runner of its own. The buttons themselves are pressed in the browser tests.
import { describe, expect, it, vi } from 'vitest';
import { createActionGate, NO_GATE } from '../../apps/web/src/lib/action-gate';

describe('the gate on a page of forms', () => {
  it('is open until a form is on its way, and open again once it has landed', () => {
    const gate = createActionGate();
    expect(gate.isHeld()).toBe(false);
    const letGo = gate.hold();
    expect(gate.isHeld()).toBe(true);
    letGo();
    expect(gate.isHeld()).toBe(false);
  });

  it('stays held until the last of several has landed', () => {
    const gate = createActionGate();
    const first = gate.hold();
    const second = gate.hold();
    first();
    expect(gate.isHeld()).toBe(true);
    second();
    expect(gate.isHeld()).toBe(false);
  });

  it('counts letting go twice once, so one form cannot open the gate on another', () => {
    const gate = createActionGate();
    const first = gate.hold();
    const second = gate.hold();
    first();
    first();
    expect(gate.isHeld()).toBe(true);
    second();
    expect(gate.isHeld()).toBe(false);
  });

  it('tells the buttons as soon as it changes, and only those still listening', () => {
    const gate = createActionGate();
    const button = vi.fn(() => gate.isHeld());
    const stopListening = gate.subscribe(button);

    const letGo = gate.hold();
    expect(button).toHaveBeenCalledTimes(1);
    expect(button).toHaveLastReturnedWith(true);
    letGo();
    expect(button).toHaveBeenCalledTimes(2);
    expect(button).toHaveLastReturnedWith(false);

    stopListening();
    gate.hold();
    expect(button).toHaveBeenCalledTimes(2);
  });

  it('keeps one page from holding back another', () => {
    const [here, there] = [createActionGate(), createActionGate()];
    here.hold();
    expect(there.isHeld()).toBe(false);
  });

  it('never holds a form on a page that has no gate', () => {
    const letGo = NO_GATE.hold();
    expect(NO_GATE.isHeld()).toBe(false);
    letGo();
    expect(NO_GATE.isHeld()).toBe(false);
  });
});
