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
  name,
  value,
  formNoValidate,
}: {
  children: ReactNode;
  className?: string | undefined;
  label?: string | undefined;
  working?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  formNoValidate?: boolean | undefined;
}) {
  const { pending, data } = useFormStatus();
  const submitting = pending && (!name || data?.get(name) === value);
  const held = useActionGate(pending);
  return (
    <>
      <button
        className={className}
        type="submit"
        disabled={pending || held}
        aria-busy={submitting}
        aria-label={label}
        name={name}
        value={value}
        formNoValidate={formNoValidate}
      >
        {children}
      </button>
      <span className="pending" role="status">
        {submitting ? working : ''}
      </span>
    </>
  );
}
