// The tool gateway reaches M3 through this and nothing else (ADR-028). It is M3's real service: M3's
// workflow does the sending, with its own attempt row and its own at-most-one rule (ADR-027 D2). When M3's
// slices merge, `proposeExternalActionInTx` stops refusing, and this file does not change.
import { externalActions } from '@ensemus/database';
import type { ExternalActionStatus } from '@ensemus/domain/external-action';
import { eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { proposeDraftActionInTx, proposeExternalActionInTx } from '../external-actions';
import type { ExternalActionPort } from './ports';

export const externalActionPort: ExternalActionPort = {
  propose: (tx, context, input) => proposeExternalActionInTx(tx, context, input),
  proposeDraft: (tx, context, input) => proposeDraftActionInTx(tx, context, input),

  async readState(tx, _context, externalActionId) {
    const [row] = await tx
      .select({ status: externalActions.status, approvalId: externalActions.approvalId })
      .from(externalActions)
      .where(eq(externalActions.id, externalActionId));
    if (!row) throw new AppError('NOT_FOUND');
    return { status: row.status as ExternalActionStatus, approvalId: row.approvalId };
  },
};
