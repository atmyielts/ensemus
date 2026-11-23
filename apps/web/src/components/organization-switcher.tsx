'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadOrganizationChoices } from '@/server/organization-switch-actions';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
type Choices =
  | { state: 'loading' | 'failed' }
  | { state: 'ready'; organizations: Awaited<ReturnType<typeof loadOrganizationChoices>> };

const notice = {
  loading: 'Loading workspaces…',
  failed: 'Could not load workspaces.',
  ready: 'No workspaces available.',
};

export function OrganizationSwitcher({ current }: { current: string }) {
  const [enhanced, setEnhanced] = useState(false);
  const [choices, setChoices] = useState<Choices>({ state: 'loading' });
  const request = useRef(0);
  const [, startTransition] = useTransition();

  function openChanged(open: boolean) {
    const sequence = ++request.current;
    setChoices({ state: 'loading' });
    if (!open) return;
    startTransition(async () => {
      try {
        const organizations = await loadOrganizationChoices();
        if (request.current === sequence) setChoices({ state: 'ready', organizations });
      } catch {
        if (request.current === sequence) setChoices({ state: 'failed' });
      }
    });
  }

  useEffect(() => setEnhanced(true), []);
  if (!enhanced)
    return (
      <Button asChild variant="ghost" size="sm" className="workspace-switch justify-start">
        <Link href="/" prefetch={false}>
          Switch organization <ChevronsUpDownIcon aria-hidden="true" />
        </Link>
      </Button>
    );
  return (
    <DropdownMenu onOpenChange={openChanged}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="workspace-switch justify-start">
          Switch organization
          <ChevronsUpDownIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" loop>
        <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
        {choices.state === 'ready' && choices.organizations.length > 0 ? (
          choices.organizations.map((organization) => (
            <DropdownMenuItem key={organization.id} asChild>
              <Link
                href={`/o/${organization.id}`}
                prefetch={false}
                aria-current={organization.id === current ? 'true' : undefined}
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0 wrap-anywhere">{organization.name}</span>
                {organization.id === current && (
                  <CheckIcon className="shrink-0" aria-hidden="true" />
                )}
              </Link>
            </DropdownMenuItem>
          ))
        ) : (
          <div className="px-1.5 py-1 text-xs text-muted-foreground" role="status">
            {notice[choices.state]}
          </div>
        )}
        <DropdownMenuItem asChild>
          <Link href="/" prefetch={false}>
            Open workspace list
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
