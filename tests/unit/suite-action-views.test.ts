// The approval page's view of each suite change (ADR-038 D6): every tool that writes or drafts has one,
// and each shows what a reviewer relies on, from the payload and this organization's rows alone.
// Generated values only.
import { payloadAddresses } from '@ensemus/application/ai-tool-approvals';
import { SUITE_TOOL_ARGS_SCHEMAS } from '@ensemus/contracts/ai-tools';
import { TOOL_MANIFESTS, type ToolManifest } from '@ensemus/domain/ai-tools';
import { isSuiteRule } from '@ensemus/domain/suite-tools';
import { describe, expect, it } from 'vitest';
import {
  SUITE_ACTION_VIEWS,
  suiteActionView,
  TABLE_MAX_ROWS,
  type SuiteViewFacts,
  type ViewField,
} from '../../apps/web/src/lib/suite-action-view';

const CONNECTION = '6f1c2c6e-8888-4888-8888-888888888888';
const MEMBER = 'ines@example.invalid';
const STRANGER = 'guest@elsewhere.example.invalid';

const facts: SuiteViewFacts = {
  connection: {
    connectorType: 'google_workspace',
    displayName: 'Generated workspace',
    ownerKind: 'member',
    ownerName: 'Ines Initiator',
  },
  memberAddresses: new Set([MEMBER]),
};

const mail = { message: { to: [MEMBER], cc: [STRANGER], subject: 'Plan', text_body: 'Line one' } };
const event = {
  calendar_id: 'primary',
  summary: 'Review',
  start: '2026-11-12T10:00:00Z',
  end: '2026-11-12T11:00:00Z',
  time_zone: 'Europe/London',
  attendees: [STRANGER],
  send_updates: 'none',
};
const file = { name: 'notes.txt', media_type: 'text/plain', text: 'héllo' };
const rows = Array.from({ length: TABLE_MAX_ROWS + 5 }, (_, r) => [`r${r}`, r, null]);

/** One valid payload per tool, as an approval would bind it. */
const SAMPLES: Record<string, unknown> = {
  'gmail.send': mail,
  'gmail.create_draft': mail,
  'outlook.send': mail,
  'outlook.create_draft': mail,
  'calendar.create_event': event,
  'calendar.update_event': {
    calendar_id: 'primary',
    event_id: 'evt1',
    send_updates: 'all',
    changes: { start: '2026-11-13T09:00:00Z', time_zone: 'Asia/Tokyo', attendees: [] },
  },
  'drive.create_file': file,
  'onedrive.create_file': file,
  'docs.edit': {
    document_id: 'doc1',
    required_revision_id: 'rev7',
    edits: [
      { kind: 'insert_text', index: 1, text: 'Inserted words' },
      { kind: 'replace_all_text', find: 'old', replace: 'new', match_case: true },
      { kind: 'delete_range', start_index: 2, end_index: 4 },
    ],
  },
  'sheets.write_range': {
    spreadsheet_id: 'sheet1',
    range: 'A1:C55',
    values: rows,
    value_input: 'user_entered',
  },
  'excel.write_range': {
    drive_id: 'b!drive',
    item_id: 'item1',
    worksheet: 'Sheet1',
    range: 'A1:C55',
    values: rows,
  },
  'teams.post_message': {
    team_id: 'team1',
    channel_id: '19:channel@thread.tacv2',
    text_body: 'Posted words',
  },
};

const writes = (TOOL_MANIFESTS as readonly ToolManifest[]).filter(
  (tool) =>
    tool.connection !== undefined &&
    isSuiteRule(tool.connection) &&
    (tool.class === 'external_write' || tool.class === 'draft_only'),
);

const field = (fields: readonly ViewField[], label: string) =>
  fields.find((each) => each.label === label);
const shown = (fields: readonly ViewField[]) => JSON.stringify(fields);

describe('the approval page’s view of each suite change', () => {
  it('has a view for exactly every suite tool that writes or drafts', () => {
    expect(Object.keys(SUITE_ACTION_VIEWS).sort()).toEqual(writes.map((tool) => tool.id).sort());
    expect(Object.keys(SAMPLES).sort()).toEqual(writes.map((tool) => tool.id).sort());
  });

  it.each(writes.map((tool) => tool.id))('%s shows its connection and owner', (id) => {
    const payload = SAMPLES[id];
    expect(
      SUITE_TOOL_ARGS_SCHEMAS[id as keyof typeof SUITE_TOOL_ARGS_SCHEMAS].safeParse({
        ...(payload as object),
        connection_id: CONNECTION,
      }).success,
      id,
    ).toBe(true);
    const view = suiteActionView(id, CONNECTION, payload, facts)!;
    expect(view, id).not.toBeNull();
    expect(field(view.fields, 'Through')).toEqual({
      kind: 'text',
      label: 'Through',
      text: 'Google Workspace, Ines Initiator’s own account, named “Generated workspace”',
    });
    expect(view.reach.length).toBeGreaterThan(0);
  });

  it('marks every recipient outside the organization, and shows subject and text as written', () => {
    const view = suiteActionView('gmail.send', CONNECTION, mail, facts)!;
    expect(field(view.fields, 'To')).toMatchObject({
      addresses: [{ address: MEMBER, outside: false }],
    });
    expect(field(view.fields, 'Copied')).toMatchObject({
      addresses: [{ address: STRANGER, outside: true }],
    });
    expect(field(view.fields, 'Subject')).toMatchObject({ text: 'Plan' });
    expect(field(view.fields, 'Text')).toMatchObject({ kind: 'body', text: 'Line one' });
    expect(view.reach).toContain('1 of them not members here');
  });

  it('shows an event’s times in its own zone, its attendees and who is told', () => {
    const view = suiteActionView('calendar.create_event', CONNECTION, event, facts)!;
    const starts = field(view.fields, 'Starts') as { text: string };
    expect(starts.text).toContain('2026-11-12T10:00:00Z, Europe/London');
    expect(starts.text).toContain('10:00:00');
    expect(field(view.fields, 'Invited')).toMatchObject({
      addresses: [{ address: STRANGER, outside: true }],
    });
    expect(field(view.fields, 'Who is told')).toMatchObject({ text: 'Nobody is told' });
    const change = suiteActionView(
      'calendar.update_event',
      CONNECTION,
      SAMPLES['calendar.update_event'],
      facts,
    )!;
    expect(shown(change.fields)).toContain('Nobody: everyone invited is removed');
    expect(field(change.fields, 'New start')).toMatchObject({
      text: expect.stringContaining('Asia/Tokyo'),
    });
  });

  it('shows a file’s name and exact size in bytes', () => {
    const view = suiteActionView('onedrive.create_file', CONNECTION, file, facts)!;
    expect(field(view.fields, 'File name')).toMatchObject({ text: 'notes.txt' });
    expect(field(view.fields, 'Size')).toMatchObject({ text: '6 bytes' });
    expect(field(view.fields, 'Contents')).toMatchObject({ text: 'héllo' });
  });

  it('shows a document edit’s exact text and the revision it applies to', () => {
    const view = suiteActionView('docs.edit', CONNECTION, SAMPLES['docs.edit'], facts)!;
    expect(field(view.fields, 'Only if the document is still at revision')).toMatchObject({
      text: 'rev7',
    });
    expect(shown(view.fields)).toContain('Inserted words');
    expect(shown(view.fields)).toContain('Positions 2 up to 4');
    expect(view.reach).toContain('rev7');
  });

  it('shows a range and its values as a bounded table, and counts what it leaves out', () => {
    for (const id of ['sheets.write_range', 'excel.write_range']) {
      const view = suiteActionView(id, CONNECTION, SAMPLES[id], facts)!;
      const values = field(view.fields, 'Values') as Extract<ViewField, { kind: 'table' }>;
      expect(values.rows).toHaveLength(TABLE_MAX_ROWS);
      expect(values.hiddenRows).toBe(5);
      expect(values.rows[1]).toEqual(['r1', '1', '(left as it is)']);
      expect(field(view.fields, 'Range')).toMatchObject({ text: 'A1:C55' });
    }
  });

  it('shows a Teams post’s team, channel and message', () => {
    const view = suiteActionView(
      'teams.post_message',
      CONNECTION,
      SAMPLES['teams.post_message'],
      facts,
    )!;
    expect(field(view.fields, 'Team')).toMatchObject({ text: 'team1' });
    expect(field(view.fields, 'Channel')).toMatchObject({ text: '19:channel@thread.tacv2' });
    expect(field(view.fields, 'Message')).toMatchObject({ text: 'Posted words' });
  });

  it('says so when the connection cannot be seen, and falls back for a payload that does not fit', () => {
    const hidden = suiteActionView('gmail.send', CONNECTION, mail, {
      connection: null,
      memberAddresses: new Set(),
    })!;
    expect(field(hidden.fields, 'Through')).toMatchObject({
      text: expect.stringContaining('cannot see'),
    });
    expect(suiteActionView('gmail.send', CONNECTION, { message: {} }, facts)).toBeNull();
    expect(suiteActionView('gmail.search', CONNECTION, { query: 'x' }, facts)).toBeNull();
    expect(suiteActionView('email.send', CONNECTION, mail, facts)).toBeNull();
  });

  it('collects every address a payload names, lower-cased, to ask which are members', () => {
    expect(
      payloadAddresses({
        message: {
          to: ['A@Example.invalid'],
          cc: ['b@example.invalid'],
          bcc: ['c@example.invalid'],
        },
      }).sort(),
    ).toEqual(['a@example.invalid', 'b@example.invalid', 'c@example.invalid']);
    expect(payloadAddresses({ attendees: ['d@example.invalid'] })).toEqual(['d@example.invalid']);
    expect(payloadAddresses({ changes: { attendees: ['e@example.invalid'] } })).toEqual([
      'e@example.invalid',
    ]);
    expect(payloadAddresses({ text: 'x' })).toEqual([]);
  });
});
