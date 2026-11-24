'use client';
import { Card } from '@/components/ui/card';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

import { useActionState, useEffect, useRef } from 'react';
import { requestBusinessRecordReview } from '@/server/business-record-actions';
import { ErrorNotice } from './ui';
import { SubmitButton } from './submit-button';
import type { BusinessProposalFormState } from '@/lib/business-proposal-form';
type Props = {
  organizationId: string;
  recordId: string;
  requestKey: string;
  kind: 'update' | 'note' | 'invoice';
  title: string;
  sourceVersion: string | null;
  fields: readonly string[];
  reviewers: readonly { membershipId: string; name: string | null }[];
  customer?: string;
  currency?: string;
};
const labels: Record<string, string> = {
  status: 'Status',
  stage: 'Stage',
  next_step: 'Next step',
  job_title: 'Job title',
  close_on: 'Close date',
  priority: 'Priority',
  assignee_ref: 'Assigned person reference',
  due_on: 'Due date',
  memo: 'Memo',
  reference: 'Reference',
};
export function BusinessProposalForm(props: Props) {
  const [state, action] = useActionState(
    requestBusinessRecordReview,
    {} as BusinessProposalFormState,
    `/o/${props.organizationId}/records/${props.recordId}?proposal=${props.kind}`,
  );
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.code) errorRef.current?.focus();
  }, [state.code, state.revision]);
  const value = (name: string, fallback = '') => state.values?.[name] ?? fallback;
  const prefix = 'business-' + props.kind;
  return (
    <Card asChild>
      <section className="card stack" aria-labelledby={prefix + '-heading'}>
        <h2 id={prefix + '-heading'}>
          {props.kind === 'update'
            ? 'Propose a field change'
            : props.kind === 'note'
              ? 'Propose an internal ticket note'
              : 'Propose an invoice draft'}
        </h2>
        <p>
          Creates Work and shares it with the reviewer you choose. After approval, Ensemus attempts
          exactly the proposed change.
        </p>
        {props.kind === 'invoice' && (
          <p>A draft posts and pays nothing. Someone reviews it in the accounting system.</p>
        )}
        <div ref={errorRef} tabIndex={-1}>
          {state.code && <ErrorNotice code={state.code} />}
        </div>
        <form action={action} className="fields" key={state.revision ?? 0}>
          <input type="hidden" name="organizationId" value={props.organizationId} />
          <input type="hidden" name="recordId" value={props.recordId} />
          <input type="hidden" name="requestKey" value={props.requestKey} />
          <input type="hidden" name="kind" value={props.kind} />
          <input type="hidden" name="sourceVersion" value={JSON.stringify(props.sourceVersion)} />
          <Label htmlFor={prefix + '-title'}>Work title</Label>
          <Input
            id={prefix + '-title'}
            name="title"
            required
            maxLength={200}
            defaultValue={value('title', props.title)}
          />
          {props.kind === 'update' && (
            <>
              <Label htmlFor={prefix + '-field'}>Field to change</Label>
              <NativeSelect
                id={prefix + '-field'}
                name="field"
                defaultValue={value('field', props.fields[0] ?? '')}
                required
              >
                {props.fields.map((name) => (
                  <option key={name} value={name}>
                    {labels[name] ?? name}
                  </option>
                ))}
              </NativeSelect>
              <Label htmlFor={prefix + '-value'}>New value</Label>
              <Input
                id={prefix + '-value'}
                name="value"
                maxLength={8000}
                defaultValue={value('value')}
              />
              <Label className="row">
                <input
                  type="checkbox"
                  name="clearValue"
                  defaultChecked={value('clearValue') === 'on'}
                />
                Clear this field
              </Label>
              <p className="muted">For a date, use YYYY-MM-DD.</p>
            </>
          )}
          {props.kind === 'note' && (
            <>
              <Label htmlFor={prefix + '-body'}>Internal note</Label>
              <Textarea
                id={prefix + '-body'}
                name="body"
                required
                maxLength={8000}
                rows={5}
                defaultValue={value('body')}
              />
              <p className="muted">
                Only an internal note can be proposed here. This does not send a reply to the
                customer.
              </p>
            </>
          )}
          {props.kind === 'invoice' && (
            <>
              <Label htmlFor={prefix + '-customer'}>Customer reference</Label>
              <Input
                id={prefix + '-customer'}
                name="customer"
                required
                maxLength={200}
                defaultValue={value('customer', props.customer)}
              />
              <Label htmlFor={prefix + '-currency'}>Currency (three-letter code)</Label>
              <Input
                id={prefix + '-currency'}
                name="currency"
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                defaultValue={value('currency', props.currency)}
              />
              <Label htmlFor={prefix + '-description'}>Line description</Label>
              <Input
                id={prefix + '-description'}
                name="description"
                required
                maxLength={500}
                defaultValue={value('description')}
              />
              <Label htmlFor={prefix + '-quantity'}>Quantity</Label>
              <Input
                id={prefix + '-quantity'}
                name="quantity"
                required
                inputMode="decimal"
                defaultValue={value('quantity', '1')}
              />
              <Label htmlFor={prefix + '-price'}>Unit price</Label>
              <Input
                id={prefix + '-price'}
                name="unitPrice"
                required
                inputMode="decimal"
                defaultValue={value('unitPrice')}
              />
              <Label htmlFor={prefix + '-memo'}>Memo (optional)</Label>
              <Textarea
                id={prefix + '-memo'}
                name="memo"
                maxLength={1000}
                rows={3}
                defaultValue={value('memo')}
              />
            </>
          )}
          <Label htmlFor={prefix + '-reviewer'}>Independent reviewer</Label>
          <NativeSelect
            id={prefix + '-reviewer'}
            name="reviewer"
            required
            defaultValue={value('reviewer')}
          >
            <option value="" disabled>
              Choose someone with source access
            </option>
            {props.reviewers.map((person) => (
              <option key={person.membershipId} value={person.membershipId}>
                {person.name ?? 'Unnamed person'}
              </option>
            ))}
          </NativeSelect>
          <SubmitButton>Request review</SubmitButton>
        </form>
      </section>
    </Card>
  );
}
