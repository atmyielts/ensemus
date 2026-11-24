import { businessPayload } from './business-action-payload';
export type BusinessRevisionField = {
  name: string;
  label: string;
  value: string;
  maxLength: number;
  required: boolean;
  multiline?: boolean;
  clearable?: boolean;
  cleared?: boolean;
};
const title = (name: string) =>
  name.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
/** Describes only the reviewed values; source identity and version are never editable inputs. */
export function businessRevisionFields(
  tool: string,
  payload: unknown,
): BusinessRevisionField[] | null {
  const p = businessPayload(tool, payload);
  if (!p) return null;
  if (p.kind === 'update')
    return Object.entries(p.data.changes).map(([name, value]) => ({
      name: 'change.' + name,
      label: title(name),
      value: value === null ? '' : String(value),
      maxLength: 8000,
      required: false,
      clearable: true,
      cleared: value === null,
    }));
  if (p.kind === 'note')
    return [
      {
        name: 'body',
        label: 'Internal note',
        value: p.data.body,
        maxLength: 8000,
        required: true,
        multiline: true,
      },
    ];
  return [
    {
      name: 'customer_ref',
      label: 'Customer reference',
      value: p.data.customer_ref,
      maxLength: 200,
      required: true,
    },
    { name: 'currency', label: 'Currency', value: p.data.currency, maxLength: 3, required: true },
    {
      name: 'due_on',
      label: 'Due date (YYYY-MM-DD)',
      value: p.data.due_on ?? '',
      maxLength: 10,
      required: false,
    },
    {
      name: 'reference',
      label: 'Reference',
      value: p.data.reference ?? '',
      maxLength: 200,
      required: false,
    },
    {
      name: 'memo',
      label: 'Memo',
      value: p.data.memo ?? '',
      maxLength: 1000,
      required: false,
      multiline: true,
    },
    ...p.data.lines.flatMap((line, index) => [
      {
        name: `line.${index}.description`,
        label: `Line ${index + 1}: description`,
        value: line.description,
        maxLength: 500,
        required: true,
      },
      {
        name: `line.${index}.quantity`,
        label: `Line ${index + 1}: quantity`,
        value: line.quantity,
        maxLength: 26,
        required: true,
      },
      {
        name: `line.${index}.unit_price`,
        label: `Line ${index + 1}: unit price`,
        value: line.unit_price,
        maxLength: 26,
        required: true,
      },
    ]),
  ];
}
/** Rebuild from the authorized stored proposal. Posted target IDs/version/tool cannot replace it. */
export function businessRevisionPayload(
  tool: string,
  payload: unknown,
  values: Record<string, string>,
): unknown | null {
  const p = businessPayload(tool, payload),
    fields = businessRevisionFields(tool, payload);
  if (
    !p ||
    !fields ||
    fields.some(
      (field) =>
        typeof values[field.name] !== 'string' || values[field.name]!.length > field.maxLength,
    )
  )
    return null;
  let next: unknown;
  if (p.kind === 'update')
    next = {
      ...p.data,
      changes: Object.fromEntries(
        Object.keys(p.data.changes).map((name) => [
          name,
          values['clear.change.' + name] === 'on' ? null : values['change.' + name],
        ]),
      ),
    };
  else if (p.kind === 'note') next = { ...p.data, body: values.body };
  else
    next = {
      customer_ref: values.customer_ref,
      currency: values.currency,
      ...(values.due_on ? { due_on: values.due_on } : {}),
      ...(values.reference ? { reference: values.reference } : {}),
      ...(values.memo ? { memo: values.memo } : {}),
      lines: p.data.lines.map((_, i) => ({
        description: values[`line.${i}.description`],
        quantity: values[`line.${i}.quantity`],
        unit_price: values[`line.${i}.unit_price`],
      })),
    };
  const parsed = businessPayload(tool, next);
  return parsed?.data ?? null;
}
