'use server';
import {
  AppError,
  idSchema,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import * as objects from '@ensemus/application/custom-objects';
import {
  createObjectTypeSchema,
  createObjectRecordSchema,
  updateObjectRecordSchema,
} from '@ensemus/contracts/custom-objects';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  objectText,
  objectFormValues,
  objectShapeInput,
  objectAttributeInput,
  type ObjectFormState,
} from '@/lib/object-input';
import { stepUpPath } from '@/lib/step-up';
import { requireTenant } from './tenant';
import { getRuntime } from './runtime';
import { createObjectOnce } from './object-api';
const identifier = (f: FormData, key: string) => {
  const parsed = idSchema.safeParse(objectText(f, key));
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const version = (f: FormData) => {
  const raw = objectText(f, 'version');
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) throw new AppError('INVALID_INPUT');
  return Number(raw);
};
type Tenant = Awaited<ReturnType<typeof requireTenant>>;
async function run(
  state: ObjectFormState,
  form: FormData,
  effect: (t: Tenant, org: string) => Promise<string>,
): Promise<ObjectFormState> {
  const org = identifier(form, 'organizationId'),
    tenant = await requireTenant(org);
  let path: string;
  try {
    path = await effect(tenant, org);
    revalidatePath(`/o/${org}/objects`, 'layout');
  } catch (error) {
    if (isAuditedRefusal(error))
      await auditRefusal(tenant.database, tenant.context, {
        surface: 'web',
        code: refusalCode(error),
      }).catch((e) => getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(e) }));
    if (error instanceof AppError && error.code === 'SSO_REQUIRED') redirect('/sign-in/sso');
    if (error instanceof AppError && error.code === 'MFA_REQUIRED') {
      const record = objectText(form, 'recordId');
      redirect(
        stepUpPath(
          org,
          record && idSchema.safeParse(record).success
            ? `/o/${org}/objects/records/${record}`
            : `/o/${org}/objects`,
        ),
      );
    }
    if (!(error instanceof AppError)) throw error;
    return {
      code: error.code,
      values: objectFormValues(form),
      revision: (state.revision ?? 0) + 1,
    };
  }
  redirect(path);
}
export async function saveObjectTypeAction(state: ObjectFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    const shape = objectShapeInput(form),
      typeId = objectText(form, 'typeId');
    if (typeId) {
      await objects.addObjectTypeVersion(database, context, {
        typeId: identifier(form, 'typeId'),
        expectedVersion: version(form),
        ...shape,
      });
      return `/o/${org}/objects/types/${identifier(form, 'typeId')}?saved=1`;
    }
    const parsed = createObjectTypeSchema.safeParse({
      slug: objectText(form, 'slug'),
      display_name: objectText(form, 'displayName'),
      classification: objectText(form, 'classification'),
      ...shape,
    });
    if (!parsed.success) throw new AppError('OBJECT_SCHEMA_INVALID');
    const input = {
      slug: parsed.data.slug,
      displayName: parsed.data.display_name,
      classification: parsed.data.classification,
      ...shape,
    };
    const saved = await createObjectOnce(
      database,
      context,
      identifier(form, 'requestKey'),
      'object-type',
      input,
      (db) => objects.createObjectType(db, context, input),
    );
    const t = await objects.getObjectType(database, context, saved);
    return `/o/${org}/objects/types/${t.id}`;
  });
}
export async function saveObjectRecordAction(state: ObjectFormState, form: FormData) {
  return run(state, form, async ({ database, context }, org) => {
    const recordId = objectText(form, 'recordId'),
      typeId = identifier(form, 'typeId');
    const shape = recordId
      ? await objects.getObjectRecordShape(database, context, identifier(form, 'recordId'))
      : await objects.getObjectType(database, context, typeId);
    const input = {
      display_name: objectText(form, 'displayName'),
      classification: objectText(form, 'classification'),
      attributes: objectAttributeInput(form, shape.fields),
    };
    const parsed = (recordId ? updateObjectRecordSchema : createObjectRecordSchema).safeParse(
      input,
    );
    if (!parsed.success) throw new AppError('OBJECT_RECORD_INVALID');
    // IDs/version/schema are rechecked in the effect, never granted by the rendered form.
    const effect = {
      displayName: input.display_name,
      ...(parsed.data.classification ? { classification: parsed.data.classification } : {}),
      attributes: input.attributes,
    };
    const r = recordId
      ? await objects.updateObjectRecord(database, context, {
          recordId: identifier(form, 'recordId'),
          expectedVersion: version(form),
          ...effect,
        })
      : await objects.getObjectRecord(
          database,
          context,
          await createObjectOnce(
            database,
            context,
            identifier(form, 'requestKey'),
            'object-record',
            { typeId, ...effect },
            (db) => objects.createObjectRecord(db, context, { typeId, ...effect }),
          ),
        );
    return `/o/${org}/objects/records/${r.id}`;
  });
}
async function native(form: FormData, effect: (t: Tenant, org: string) => Promise<string>) {
  const state = await run({}, form, effect);
  const org = identifier(form, 'organizationId');
  redirect(`/o/${org}/objects?error=${encodeURIComponent(state.code ?? 'INVALID_INPUT')}`);
}
export async function deleteObjectRecordAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const typeId = identifier(form, 'typeId');
    await objects.deleteObjectRecord(database, context, {
      recordId: identifier(form, 'recordId'),
      expectedVersion: version(form),
    });
    return `/o/${org}/objects/types/${typeId}`;
  });
}
export async function raiseObjectTypeAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const parsed = createObjectTypeSchema.shape.classification.safeParse(
      objectText(form, 'classification'),
    );
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const t = await objects.raiseObjectTypeClassification(database, context, {
      typeId: identifier(form, 'typeId'),
      expectedVersion: version(form),
      classification: parsed.data,
    });
    return `/o/${org}/objects/types/${t.id}`;
  });
}
export async function linkObjectRecordsAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const fromRecordId = identifier(form, 'recordId');
    await objects.linkObjectRecords(database, context, {
      fromRecordId,
      toRecordId: identifier(form, 'toRecordId'),
      relationKey: objectText(form, 'relationKey'),
    });
    return `/o/${org}/objects/records/${fromRecordId}`;
  });
}
export async function unlinkObjectRecordsAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    await objects.unlinkObjectRecords(database, context, {
      relationId: identifier(form, 'relationId'),
      fromRecordId: identifier(form, 'recordId'),
    });
    return `/o/${org}/objects/records/${identifier(form, 'recordId')}`;
  });
}
export async function retryObjectMigrationAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const input = {
      typeId: identifier(form, 'typeId'),
      migrationId: identifier(form, 'migrationId'),
      expectedTypeVersion: version(form),
    };
    const migrationId = await createObjectOnce(
      database,
      context,
      identifier(form, 'requestKey'),
      'object-migration-retry',
      input,
      (db) => objects.retryObjectMigration(db, context, input),
      202,
    );
    await objects.getObjectMigration(database, context, { typeId: input.typeId, migrationId });
    return `/o/${org}/objects/types/${input.typeId}`;
  });
}
