'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { type ActionGate, createActionGate, NO_GATE } from '@/lib/action-gate';

const Gate = createContext<ActionGate>(NO_GATE);

/**
 * For a page whose forms all answer to one version. While any form in here is on its way, the buttons
 * of the others wait too, and they come back in the same update that brings the new version. A press
 * made meanwhile does nothing rather than being sent with a number already out of date. The router runs
 * a page's actions one after another anyway, so nothing that could have gone sooner is held up. A
 * refused save hands the buttons back without a new version, because it moved nothing. With JavaScript
 * off the page is replaced by each answer, so this never comes up.
 */
export function OneActionAtATime({ children }: { children: ReactNode }) {
  const [gate] = useState(createActionGate);
  return <Gate.Provider value={gate}>{children}</Gate.Provider>;
}

const NOT_HELD_ON_THE_SERVER = () => false;

/** Reports whether this form is on its way, and answers whether another one is. */
export function useActionGate(pending: boolean) {
  const gate = useContext(Gate);
  // Before anything is painted, so there is no moment when the other buttons look ready to press.
  useLayoutEffect(() => (pending ? gate.hold() : undefined), [gate, pending]);
  return useSyncExternalStore(gate.subscribe, gate.isHeld, NOT_HELD_ON_THE_SERVER);
}
