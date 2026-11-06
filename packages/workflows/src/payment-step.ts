// This module runs inside a workflow. Its dependencies are types, and its ports carry no billing details.
import type { PaymentCode } from '@ensemus/saas/payment';
import type {
  ChargeStep,
  InterruptedPaymentStep,
  PaymentOutcome,
  PaymentReconcileStep,
} from './saas-schemas';

export type PaymentStepPorts = {
  charge(): Promise<ChargeStep>;
  inspect(): Promise<InterruptedPaymentStep>;
  reconcile(): Promise<PaymentReconcileStep>;
  concludeWithoutAnswer(): Promise<PaymentReconcileStep>;
  failUnsent(code: PaymentCode): Promise<void>;
  outcome(): Promise<PaymentOutcome>;
  sleep(ms: number): Promise<void>;
  neverPickedUp(error: unknown): boolean;
};

// These bound recovery from worker failures; they are operational limits, not collection policy.
const MAX_LOST_CHARGES = 5;
const delay = (tries: number) => Math.min(30_000 * 2 ** Math.min(tries - 1, 4), 300_000);

/** Only a committed not-sent fact, or authoritative absence, permits another charge invocation. */
export async function runPayment(ports: PaymentStepPorts): Promise<PaymentOutcome> {
  const reconcile = async () => {
    try {
      return await ports.reconcile();
    } catch {
      return ports.concludeWithoutAnswer();
    }
  };
  let lostCharges = 0;
  let reconciledRetries = 0;
  for (;;) {
    let step: ChargeStep;
    try {
      step = await ports.charge();
    } catch (error) {
      lostCharges += 1;
      const state = await ports.inspect();
      if (state === 'settled') return ports.outcome();
      if (state === 'attempt_open') step = { step: 'reconcile' };
      else if (ports.neverPickedUp(error) || lostCharges >= MAX_LOST_CHARGES) {
        await ports.failUnsent(
          ports.neverPickedUp(error) ? 'PROCESSOR_NOT_CONFIGURED' : 'ATTEMPTS_EXHAUSTED',
        );
        // A late worker may have committed its claim while this failure was being recorded.
        const after = await ports.inspect();
        if (after === 'settled') return ports.outcome();
        if (after === 'nothing_sent')
          throw new Error('PAYMENT_FAILURE_NOT_RECORDED', { cause: error });
        step = { step: 'reconcile' };
      } else {
        await ports.sleep(delay(lostCharges));
        continue;
      }
    }
    if (step.step === 'retry') {
      await ports.sleep(step.afterMs);
      continue;
    }
    if (step.step !== 'reconcile') return step.step;
    const answer = await reconcile();
    if (answer !== 'retry') return answer;
    reconciledRetries += 1;
    await ports.sleep(delay(reconciledRetries));
  }
}
