'use client';
import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import type { ExperienceFormState } from '@/lib/experience-input';
import { SubmitButton } from '../submit-button';
import { ErrorNotice } from '../ui';
export function ExperienceActionForm({
  action,
  hidden,
  label,
  buttonClass,
  children,
}: {
  action: (state: ExperienceFormState, form: FormData) => Promise<ExperienceFormState>;
  hidden: Record<string, string | number>;
  label: string;
  /** Every action but the one this place is for is outlined, so only one button is lit. */
  buttonClass?: 'secondary' | 'danger';
  children?: ReactNode;
}) {
  const [state, perform] = useActionState(action, {}),
    notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) notice.current?.focus();
  }, [state]);
  return (
    <form action={perform} className="fields">
      <div tabIndex={-1} ref={notice}>
        <ErrorNotice code={state.code} />
      </div>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div>
        <SubmitButton className={buttonClass}>{label}</SubmitButton>
      </div>
    </form>
  );
}
