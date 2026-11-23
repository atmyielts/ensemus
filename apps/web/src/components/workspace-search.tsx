'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SearchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
/** The real search page remains the native link target; the dialog is an optional keyboard shortcut. */
export function WorkspaceSearch({ base }: { base: string }) {
  const [open, setOpen] = useState(false),
    trigger = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        asChild
        variant="outline"
        className="workspace-search-trigger h-8 gap-2 border-transparent bg-transparent px-2 text-xs text-muted-foreground"
      >
        <Link
          ref={trigger}
          href={`${base}/search`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          <SearchIcon aria-hidden="true" />
          <span className="workspace-search-label">Search</span>
          <kbd
            aria-hidden="true"
            className="workspace-search-shortcut rounded border border-border px-1 font-mono text-[10px]"
          >
            ⌘ K
          </kbd>
        </Link>
      </Button>
      <DialogContent
        className="sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Search the company</DialogTitle>
          <DialogDescription>
            Find work, people, clients and document passages you have access to.
          </DialogDescription>
        </DialogHeader>
        <form action={`${base}/search`} method="get" role="search" className="grid gap-4">
          <Label htmlFor="workspace-query">Search</Label>
          <Input
            id="workspace-query"
            type="search"
            name="q"
            required
            maxLength={200}
            placeholder="A name, a word or a phrase"
          />
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-xs text-muted-foreground">Esc to close</span>
            <Button type="submit">Search</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
