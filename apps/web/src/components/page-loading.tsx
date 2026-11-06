/**
 * Only for pages that never answer 404 themselves, because streaming a loading page commits the
 * response to status 200. A page that can report "not found", such as one Work Unit, has no loading
 * page, so that a hidden item keeps its real 404. The navigation shows those are on their way instead.
 */
export function PageLoading() {
  return (
    <p className="muted" role="status">
      Loading this page.
    </p>
  );
}
