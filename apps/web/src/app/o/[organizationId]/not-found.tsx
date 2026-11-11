import { ActionLink, Empty, PageHead } from '@/components/ui';

export const metadata = { title: 'Not found | Ensemus' };

// Something inside an organization someone belongs to. The navigation stays, so there is a way on. The
// wording is the same for "does not exist" and "you may not see this", so neither leaks the other. An
// organization someone is not in never gets here: its layout stops first, with the top-level page.
export default function OrganizationNotFound() {
  // A not-found page receives no params, so the way back is the address that leads home for everyone:
  // the one organization someone is in, or the list to choose from. The navigation beside it stays.
  return (
    <>
      <PageHead
        title="Page not found"
        description="This page does not exist, or you do not have access to it."
      />
      <Empty action={<ActionLink href="/">Go to your home page</ActionLink>}>
        It may have been moved or removed, or it is not shared with you. If someone sent you this
        link, ask them to check it.
      </Empty>
    </>
  );
}
