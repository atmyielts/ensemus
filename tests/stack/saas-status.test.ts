import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asRole } from '../helpers/saas';
import { BASE } from '../helpers/forms';
describe('public status requires no session', () => {
  it('shows published provider incidents and no private or drill data', async () => {
    const publicTitle = `Test provider ${randomUUID()}`,
      canary = `private-${randomUUID()}`;
    await asRole('ensemus_operator', async (client) => {
      await client.query(
        "insert into operations.incidents (severity,origin,public_title,commander_ref,postmortem_ref,published,started_at) values ('medium','model_provider',$1,$2,$2,true,now())",
        [publicTitle, canary],
      );
      await client.query(
        "insert into operations.incidents (severity,origin,public_title,commander_ref,is_drill,started_at) values ('medium','ensemus',$1,$1,true,now())",
        [canary],
      );
    });
    const response = await fetch(`${BASE}/status`),
      html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(html).toContain(publicTitle);
    expect(html).toContain('Model provider');
    expect(html).not.toContain(canary);
    expect(html).not.toContain('uptime percentage');
  });
  it('publishes the honest unconfigured external security contact', async () => {
    const response = await fetch(`${BASE}/security`),
      html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('has not yet published an external security contact');
    expect(html).toContain('require legal review');
    expect(html).not.toContain('mailto:');
  });
});
