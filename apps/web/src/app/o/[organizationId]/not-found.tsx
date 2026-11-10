import { PageHead } from '@/components/ui';

export const metadata = { title: 'Not found | Ensemus' };

// Something inside an organization someone belongs to. The navigation stays, so there is a way on. The
// wording is the same for "does not exist" and "you may not see this", so neither leaks the other. An
// organization someone is not in never gets here: its layout stops first, with the top-level page.
export default function OrganizationNotFound() {
  return (
    <PageHead
      title="Page not found"
      description="This page does not exist, or you do not have access to it."
    />
  );
}
