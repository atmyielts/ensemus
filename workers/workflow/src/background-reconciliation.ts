/** Startup repair must not delay delivery of already committed business events. */
export function createBackgroundReconciliation({
  run,
  retryMs,
  onError,
  now = Date.now,
}: {
  run: () => Promise<boolean>;
  retryMs: number;
  onError: (error: unknown) => void;
  now?: () => number;
}) {
  let active: Promise<void> | undefined;
  let completed = false;
  let stopped = false;
  let retryAt = 0;

  return {
    poll(): void {
      if (stopped || completed || active || now() < retryAt) return;
      active = Promise.resolve()
        .then(run)
        .then((done) => {
          completed = done;
        })
        .catch(onError)
        .finally(() => {
          retryAt = now() + retryMs;
          active = undefined;
        });
    },
    /** Drain the current attempt before its database and Temporal connection are closed. */
    async stop(): Promise<void> {
      stopped = true;
      await active;
    },
  };
}
