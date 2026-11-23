'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
export function OrganizationSwitcher({
  current,
  organizations,
}: {
  current: string;
  organizations: readonly { id: string; name: string }[];
}) {
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  if (!enhanced)
    return (
      <Button asChild variant="ghost" size="sm" className="workspace-switch justify-start">
        <Link href="/">
          Switch organization <ChevronsUpDownIcon aria-hidden="true" />
        </Link>
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="workspace-switch justify-start">
          Switch organization
          <ChevronsUpDownIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
        {organizations.map((organization) => (
          <DropdownMenuItem key={organization.id} asChild>
            <Link
              href={`/o/${organization.id}`}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 break-words">{organization.name}</span>
              {organization.id === current && (
                <CheckIcon className="shrink-0" aria-label="Current workspace" />
              )}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
