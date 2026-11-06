// Owned by the catalog slice (BILL-04). `DATABASE_URL_OPERATOR`. Every price comes in on the command line or from
// a file an operator names, and nothing here has a default. See docs/06-delivery/m8-slices.md.
export async function catalogCommand(_args: string[]): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
