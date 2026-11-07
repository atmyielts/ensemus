import { AppError, idSchema } from '@ensemus/application';
import type { OutcomePreview } from '@ensemus/domain/outcome-composer';
import { outcomePreviewSchema } from '@ensemus/contracts/experience';
export type ExperienceFormState = {
  code?: string;
  values?: Record<string, string | string[]>;
  revision?: number;
};
export const experienceText = (form: FormData, key: string) =>
  typeof form.get(key) === 'string' ? String(form.get(key)) : '';
export function experienceId(form: FormData, key: string) {
  const result = idSchema.safeParse(experienceText(form, key));
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
export function experienceVersion(form: FormData) {
  const text = experienceText(form, 'version');
  if (!/^[1-9]\d{0,9}$/.test(text) || Number(text) > 2147483647)
    throw new AppError('INVALID_INPUT');
  return Number(text);
}
export function experienceValues(form: FormData) {
  const result: Record<string, string | string[]> = {};
  let bytes = 0;
  for (const [key, value] of form) {
    if (
      typeof value !== 'string' ||
      !/^(requestKey|objective|today|title|dueAt|ownerMembershipId|classification|suggestedProcessKey|dependency|criterion_\d{1,2}_(kind|label|keep))$/.test(
        key,
      )
    )
      continue;
    bytes += key.length + value.length;
    if (bytes > 32000) throw new AppError('INVALID_INPUT');
    if (key === 'dependency')
      result[key] = form.getAll(key).filter((v): v is string => typeof v === 'string');
    else result[key] = value;
  }
  return result;
}
export function previewFromForm(form: FormData, original: OutcomePreview): OutcomePreview {
  const criteria = [];
  for (let i = 0; i <= 20; i++) {
    const label = experienceText(form, `criterion_${i}_label`);
    if (
      experienceText(form, `criterion_${i}_keep`) === 'yes' ||
      (i === original.successCriteria.length && label.trim())
    )
      criteria.push({ kind: experienceText(form, `criterion_${i}_kind`), label });
  }
  const result = outcomePreviewSchema.safeParse({
    ...original,
    title: experienceText(form, 'title'),
    objective: experienceText(form, 'objective'),
    dueAt: experienceText(form, 'dueAt') || null,
    ownerMembershipId: experienceText(form, 'ownerMembershipId'),
    classification: experienceText(form, 'classification'),
    suggestedProcessKey: experienceText(form, 'suggestedProcessKey') || null,
    dependencyWorkUnitIds: form.getAll('dependency'),
    successCriteria: criteria,
  });
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
}
