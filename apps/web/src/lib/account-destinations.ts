// Account discovery only. The destination independently checks fresh membership and capability.
import { can } from '@ensemus/domain/policy';
import type { NavigationIcon } from '../components/navigation-model';
export function accountDestinations(organizationId: string, role: string) {
  const base = `/o/${organizationId}/account`,
    items: { href: string; label: string; description: string; icon: NavigationIcon }[] = [];
  if (can(role, 'billing.view'))
    items.push({
      href: `${base}/billing`,
      label: 'Billing and subscription',
      description: 'Billing details, plan changes and cancellation.',
      icon: 'usage',
    });
  if (can(role, 'support.use'))
    items.push({
      href: `${base}/support`,
      label: 'Support',
      description: 'Ask for help with your account or its standing.',
      icon: 'people',
    });
  if (can(role, 'organization.export'))
    items.push({
      href: `${base}/exports`,
      label: 'Export your data',
      description: 'Prepare and retrieve an encrypted copy, including while service is paused.',
      icon: 'arrow',
    });
  if (can(role, 'offboarding.manage'))
    items.push({
      href: `${base}/leave`,
      label: 'Leave Ensemus',
      description: 'Review the transition and the checks before erasure.',
      icon: 'safety',
    });
  return items;
}
