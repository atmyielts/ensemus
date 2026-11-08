import { AppError, idSchema } from '@ensemus/application';
import { startProcessRunSchema } from '@ensemus/contracts/studio';
import { z } from 'zod';
export type ProcessRunFormState = {
  code?: string;
  values?: Record<string, string>;
  revision?: number;
};
export function runText(form: FormData, key: string, max = 1024) {
  const values = form.getAll(key);
  if (values.length > 1) throw new AppError('INVALID_INPUT');
  const value = values[0] ?? '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new AppError('INVALID_INPUT');
  return value;
}
export function runId(form: FormData, key: string) {
  const result = idSchema.safeParse(runText(form, key));
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
export function runVersion(form: FormData) {
  const value = runText(form, 'version', 10);
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647)
    throw new AppError('INVALID_INPUT');
  return Number(value);
}
export function readRunStart(form: FormData) {
  const day = runText(form, 'dueAt', 10);
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('INVALID_INPUT');
  const at = day ? new Date(day + 'T00:00:00.000Z') : undefined;
  if (at && (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== day))
    throw new AppError('INVALID_INPUT');
  const result = startProcessRunSchema.safeParse({
    spec_id: runText(form, 'specId', 36),
    title: runText(form, 'title', 200),
    ...(at ? { due_at: at.toISOString() } : {}),
  });
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
const email = z.strictObject({
  to: z.array(z.email().max(254)).min(1).max(50),
  subject: z.string().trim().min(1).max(200),
  textBody: z.string().min(1).max(200000),
});
export function readRunEmail(form: FormData) {
  const to = runText(form, 'to', 13000)
      .split(/[;,\n]/)
      .map((v) => v.trim())
      .filter(Boolean),
    result = email.safeParse({
      to,
      subject: runText(form, 'subject', 200),
      textBody: runText(form, 'textBody', 200000),
    });
  if (
    !result.success ||
    new TextEncoder().encode(
      JSON.stringify({
        to: result.data?.to,
        subject: result.data?.subject,
        text_body: result.data?.textBody,
      }),
    ).byteLength > 262144
  )
    throw new AppError('INVALID_INPUT');
  return result.data;
}
export function runFormValues(form: FormData, kind: 'start' | 'email') {
  const result: Record<string, string> = {};
  for (const key of kind === 'start'
    ? ['requestKey', 'specId', 'title', 'dueAt']
    : ['requestKey', 'to', 'subject', 'textBody'])
    result[key] = runText(form, key, key === 'textBody' ? 200000 : key === 'to' ? 13000 : 1024);
  return result;
}
