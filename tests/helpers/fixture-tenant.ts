import type pg from 'pg';

/** Generated superuser fixtures still bind the real row tenant for integrity/epoch triggers. */
export async function inFixtureTenant<T>(
  client: pg.Client,
  organizationId: string,
  use: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('app.organization_id',$1,true)", [organizationId]);
    const result = await use();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
