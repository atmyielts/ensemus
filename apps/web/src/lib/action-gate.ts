// Whether something on this page is on its way to the server. A form carries the version the page was
// drawn from, and that number only changes once the answer has been drawn. So a second form pressed
// while the first is on its way sends the old number, and if the first moved the work, the server
// answers that someone else changed it first, about the person's own save. See OneActionAtATime.

export type ActionGate = {
  subscribe: (listener: () => void) => () => void;
  isHeld: () => boolean;
  /** Holds the gate, and gives back how to let go. Letting go twice only counts once. */
  hold: () => () => void;
};

export function createActionGate(): ActionGate {
  let holds = 0;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isHeld: () => holds > 0,
    hold() {
      holds += 1;
      tell();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds -= 1;
        tell();
      };
    },
  };
}

/** For a form on a page with no gate: nothing holds it back, and it holds nothing back. */
export const NO_GATE: ActionGate = {
  subscribe: () => () => undefined,
  isHeld: () => false,
  hold: () => () => undefined,
};
