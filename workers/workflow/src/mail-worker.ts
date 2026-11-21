// The platform mail worker: the only process that sends Ensemus's own email (account recovery and
// verification, invitations, notifications and digests). The web tier only queues. It sits on the internal
// `mail` network alone, with PostgreSQL and its own egress gateway, so nothing in it can reach anywhere but
// the one relay an operator configured (ADR-027 D5). It runs only under the `mail` compose profile, holds
// the relay credential from a mounted file, and opens sealed links with the private sealing key.
import { writeFileSync } from 'node:fs';
import { readSecret } from '@ensemus/config';
import {
  claimAccountMail,
  claimTenantMail,
  expireOverdue,
  gatherDueDigests,
  openMailerDatabase,
  pruneSettled,
  recordOutcome,
  settleExpiredClaims,
} from '@ensemus/database/mailer';
import { notificationTopicOf } from '@ensemus/domain/mail';
import { FileKeyProvider, openSealed } from '@ensemus/secrets/broker';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { loadMailConfig } from './mail/config';
import { runMailPass, type MailStore } from './mail/loop';
import { topicOfMail } from './mail/plan';
import { createSmtpTransport } from './mail/transport';

const log = createLogger('mail-worker');
const PASS_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const UNSUBSCRIBE_DAYS = 90;

async function main() {
  const config = loadMailConfig();
  const { db, close } = openMailerDatabase(readSecret('DATABASE_URL_MAILER'));
  const keys = new FileKeyProvider([readSecret('SECRET_SEALING_PRIVATE_KEY')]);

  const store: MailStore = {
    settleExpiredClaims: (leaseMs) => settleExpiredClaims(db, leaseMs),
    expireOverdue: () => expireOverdue(db),
    pruneSettled: () => pruneSettled(db),
    gatherDueDigests: () => gatherDueDigests(db, notificationTopicOf),
    claimAccountMail: () => claimAccountMail(db, config.messageIdDomain),
    claimTenantMail: (plan) =>
      claimTenantMail(db, {
        messageIdDomain: config.messageIdDomain,
        topicOf: topicOfMail,
        plan,
        unsubscribeDays: UNSUBSCRIBE_DAYS,
      }),
    recordOutcome: (table, id, outcome) => recordOutcome(db, table, id, outcome),
  };
  const deps = {
    store,
    send: createSmtpTransport(config),
    openLink: (
      sealed: Parameters<typeof openSealed>[1],
      binding: Parameters<typeof openSealed>[2],
    ) => openSealed(keys, sealed, binding),
    log: {
      info: (event: string, fields?: Record<string, unknown>) => log.info(event, fields ?? {}),
      warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields ?? {}),
    },
    sender: { fromAddress: config.fromAddress, fromName: config.fromName },
    publicUrl: config.publicUrl,
  };

  // The container health check reads this file. A stuck pass stops updates, so it is never hidden.
  const beat = () => writeFileSync('/tmp/worker-alive', String(Date.now()));
  beat();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  log.info('mail_worker.started', {});
  let lastPrune = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastPrune > PRUNE_INTERVAL_MS) {
        await store.pruneSettled();
        lastPrune = Date.now();
      }
      const { sent, settled } = await runMailPass(deps);
      if (sent || settled) log.info('mail_worker.pass', { sent, settled });
    } catch (error) {
      // Restore review pending, the database away, or a bug: the next pass tries again, and the
      // durable state is in the rows, so nothing is lost or sent twice.
      log.warn('mail_worker.pass_failed', { errorCode: errorCode(error) });
    }
    beat();
    await new Promise((resolve) => setTimeout(resolve, PASS_INTERVAL_MS));
  }
  log.info('mail_worker.stopped', {});
  config.password.fill(0);
  await close();
}

main().catch((error: unknown) => {
  log.error('mail_worker.crashed', { errorCode: errorCode(error) });
  process.exit(1);
});
