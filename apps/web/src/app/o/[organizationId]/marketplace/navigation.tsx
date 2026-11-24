import { SectionNavigation } from '@/components/section-navigation';

export function MarketplaceNavigation({ base, canPublish }: { base: string; canPublish: boolean }) {
  return (
    <SectionNavigation
      label="Marketplace"
      items={[
        { href: base, label: 'Browse', exact: true, matches: [`${base}/listings`] },
        { href: `${base}/installations`, label: 'Installations' },
        ...(canPublish ? [{ href: `${base}/publishing`, label: 'Publishing' }] : []),
      ]}
    />
  );
}
