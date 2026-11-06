'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useActionGate } from './one-action-at-a-time';

/**
 * A submit button that shows its form is on its way, and cannot be pressed twice meanwhile, nor while
 * another form that shares its gate is on its way. Without JavaScript it is an ordinary submit button.
 * The words stay visible, so nothing moves.
 */
export function SubmitButton({
  children,
  className,
  label,
  working = 'Working on it',
}: {
  children: ReactNode;
  className?: string | undefined;
  label?: string | undefined;
  working?: string | undefined;
}) {
  const { pending } = useFormStatus();
  const held = useActionGate(pending);
  return (
    <>
      <button
        className={className}
        type="submit"
        disabled={pending || held}
        aria-busy={pending}
        aria-label={label}
      >
        {children}
      </button>
      <span className="pending" role="status">
        {pending ? working : ''}
      </span>
    </>
  );
}
