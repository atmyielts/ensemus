'use client';

import { type ChangeEvent, useState } from 'react';
import { fileRefusal } from '@/lib/work-view';

/**
 * Says at once when a file is too large, and keeps the form from sending it. Past a point the server
 * never sees such a request, so it could not say why. With JavaScript off the service still refuses a
 * file over the limit, as long as the request reaches it.
 */
export function FileField({ name, hint }: { name: string; hint: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const refusal = file ? fileRefusal(file.size) : null;
    event.target.setCustomValidity(refusal ?? '');
    setProblem(refusal);
  }
  return (
    <>
      <small>{hint}</small>
      {problem && (
        <small className="field-error" id={`${name}-error`} role="alert">
          {problem}
        </small>
      )}
      <input
        name={name}
        type="file"
        required
        onChange={choose}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${name}-error` : undefined}
      />
    </>
  );
}
