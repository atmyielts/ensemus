// Owned by the offboarding slice (LIFE-04). The last step of offboarding, which cannot be undone. `DATABASE_URL_APP`
// and `DATABASE_URL_ERASER`, and the role behind that second one cannot log in until an operator lets it.
// See docs/06-delivery/m8-slices.md and ADR-032 D7.
export async function eraseCommand(_args: string[]): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
