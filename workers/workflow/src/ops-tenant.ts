// Owned by the subscriptions slice (OPS-21). Provision, suspend, resume. `DATABASE_URL_APP`, with a service
// context, the same as reapply-ledger. See docs/06-delivery/m8-slices.md.
export async function tenantCommand(_args: string[]): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
