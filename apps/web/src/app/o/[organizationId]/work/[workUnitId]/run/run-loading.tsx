/** Shown only after the requested work and run have passed their access checks. */
export function RunLoading() {
  return (
    <p className="muted" role="status">
      Loading this run.
    </p>
  );
}
