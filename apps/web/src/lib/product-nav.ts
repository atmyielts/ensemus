// M7's places in the main navigation. A plain function, so one file holds them all and each slice only adds
// its pages. `show` says who sees a link. The page itself still checks: hiding a link protects nothing.
import { canProduct } from '@ensemus/domain/product-policy';

export type ProductNavItem = { href: string; label: string };

export function productNavItems(base: string, role: string): ProductNavItem[] {
  const items: ProductNavItem[] = [
    { href: `${base}/pulse`, label: 'Company Pulse' },
    { href: `${base}/compose`, label: 'New outcome' },
    { href: `${base}/assistants`, label: 'Assistants' },
    { href: `${base}/knowledge`, label: 'Knowledge' },
    { href: `${base}/objects`, label: 'Records' },
  ];
  if (canProduct(role, 'studio.author')) items.push({ href: `${base}/studio`, label: 'Agent Studio' });
  if (canProduct(role, 'pack.manage')) items.push({ href: `${base}/packs`, label: 'Packs' });
  if (canProduct(role, 'onboarding.manage')) {
    items.push({ href: `${base}/get-started`, label: 'Get started' });
  }
  items.push({ href: `${base}/security`, label: 'Security' });
  return items;
}
