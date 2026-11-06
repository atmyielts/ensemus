// Owned by the support slice (OPS-22, OPS-24). `DATABASE_URL_SUPPORT` for the desk, and `DATABASE_URL_OPERATOR` for
// an operator's signature on a break-glass request. See docs/06-delivery/m8-slices.md and ADR-032 D8.
export async function deskCommand(_args: string[]): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
