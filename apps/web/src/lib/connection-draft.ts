import {
  isBusinessConnectorType,
  readScopeFor,
  writeScopeFor,
} from '@ensemus/domain/business-connector';
export type ConnectionDraft = {
  connectorType: string;
  displayName: string;
  fromAddress: string;
  fromName: string;
  tlsServerName: string;
  streams: string[];
  allowWrites: boolean;
};
export function connectionDraft(form: FormData): ConnectionDraft {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  return {
    connectorType: text('connectorType'),
    displayName: text('displayName'),
    fromAddress: text('fromAddress'),
    fromName: text('fromName'),
    tlsServerName: text('tlsServerName'),
    streams: form.getAll('streams').filter((value): value is string => typeof value === 'string'),
    allowWrites: text('allowWrites') === 'yes',
  };
}
export function connectionSettings(draft: ConnectionDraft): Record<string, unknown> {
  if (isBusinessConnectorType(draft.connectorType))
    return {
      ...(draft.tlsServerName.trim() ? { tlsServerName: draft.tlsServerName.trim() } : {}),
      streams: draft.streams,
      scopes: [
        readScopeFor(draft.connectorType),
        ...(draft.allowWrites ? [writeScopeFor(draft.connectorType)] : []),
      ],
    };
  return draft.connectorType === 'email_smtp'
    ? {
        fromAddress: draft.fromAddress.trim(),
        ...(draft.fromName.trim() ? { fromName: draft.fromName.trim() } : {}),
        ...(draft.tlsServerName.trim() ? { tlsServerName: draft.tlsServerName.trim() } : {}),
      }
    : {};
}
