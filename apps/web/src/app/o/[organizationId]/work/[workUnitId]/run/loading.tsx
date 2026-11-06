/** While the page is on its way. It says nothing about the run, because nothing has been read yet. */
export default function RunLoading() {
  return (
    <p className="muted" role="status">
      Loading this run.
    </p>
  );
}
