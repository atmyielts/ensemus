import type { RecordFields } from '@ensemus/domain/business-connector';
export const sourceStreamLabels: Readonly<Record<string, string>> = {
  'crm.accounts': 'CRM accounts',
  'crm.contacts': 'CRM contacts',
  'crm.deals': 'CRM deals',
  'ticketing.tickets': 'Support tickets',
  'ticketing.comments': 'Internal ticket notes',
  'accounting.invoices': 'Accounting invoices',
  'accounting.bills': 'Accounting bills',
  'accounting.payments': 'Accounting payments',
};
const fieldLabels: Readonly<Record<string, string>> = {
  name: 'Name',
  status: 'Status',
  owner_ref: 'Owner reference',
  next_step: 'Next step',
  email: 'Email',
  phone: 'Phone',
  company_ref: 'Company reference',
  job_title: 'Job title',
  stage: 'Stage',
  amount: 'Amount',
  currency: 'Currency',
  close_on: 'Close date',
  subject: 'Subject',
  priority: 'Priority',
  assignee_ref: 'Assignee reference',
  requester_ref: 'Requester reference',
  due_on: 'Due date',
  ticket_ref: 'Ticket reference',
  author_ref: 'Author reference',
  visibility: 'Visibility',
  body: 'Note',
  posted_at: 'Posted at',
  number: 'Number',
  customer_ref: 'Customer reference',
  total: 'Total',
  memo: 'Memo',
  reference: 'Reference',
  vendor_ref: 'Vendor reference',
  direction: 'Direction',
  paid_on: 'Payment date',
};
export function SourceRecordFields({ fields }: { fields: RecordFields }) {
  return (
    <dl className="details source-record-fields">
      {Object.entries(fields).map(([name, value]) => (
        <div key={name}>
          <dt>{fieldLabels[name] ?? name.replaceAll('_', ' ')}</dt>
          <dd>
            {value === null
              ? 'Not provided'
              : typeof value === 'boolean'
                ? value
                  ? 'Yes'
                  : 'No'
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
