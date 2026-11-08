import { OBJECT_LIMITS } from '@ensemus/domain/custom-object';

/** Count rendered rows as well as typed ones, so a refused submit keeps blank additions too. */
export function objectEditorRows(
  values: Readonly<Record<string, string>> | undefined,
  fields = 1,
  relations = 0,
) {
  let fieldRows = Math.max(1, fields),
    relationRows = relations;
  for (const [key, value] of Object.entries(values ?? {})) {
    if (key === 'fieldRows' && /^\d{1,2}$/.test(value))
      fieldRows = Math.max(fieldRows, Number(value));
    if (key === 'relationRows' && /^\d{1,2}$/.test(value))
      relationRows = Math.max(relationRows, Number(value));
    const match = /^(field|relation)_(\d{1,2})_/.exec(key);
    if (match) {
      if (match[1] === 'field') fieldRows = Math.max(fieldRows, Number(match[2]) + 1);
      else relationRows = Math.max(relationRows, Number(match[2]) + 1);
    }
  }
  return {
    fields: Math.min(OBJECT_LIMITS.maxFields, fieldRows),
    relations: Math.min(OBJECT_LIMITS.maxRelations, relationRows),
  };
}

/** Native editor convenience only. Explicit keys and the strict API parser keep their semantics. */
export function withGeneratedObjectKeys(form: FormData): FormData {
  const result = new FormData();
  for (const [key, value] of form) result.append(key, value);
  for (const [kind, limit] of [
    ['field', OBJECT_LIMITS.maxFields],
    ['relation', OBJECT_LIMITS.maxRelations],
  ] as const) {
    const used = new Set<string>();
    for (let index = 0; index < limit; index++) {
      const key = form.get(`${kind}_${index}_key`);
      if (typeof key === 'string' && key) used.add(key);
    }
    for (let index = 0; index < limit; index++) {
      const prefix = `${kind}_${index}_`,
        key = form.get(prefix + 'key'),
        label = form.get(prefix + 'label');
      if (key !== null && key !== '') continue;
      if (typeof label !== 'string' || !label.trim()) continue;
      const normalized = label
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const base = (
        /^[a-z]/.test(normalized) ? normalized : `${kind}_${normalized || index + 1}`
      ).slice(0, 63);
      let candidate = base,
        suffix = 2;
      while (used.has(candidate)) {
        const ending = `_${suffix++}`;
        candidate = base.slice(0, 63 - ending.length) + ending;
      }
      used.add(candidate);
      result.set(prefix + 'key', candidate);
    }
  }
  return result;
}
