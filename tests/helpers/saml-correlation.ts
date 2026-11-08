// Negative fault only, against one real native-generated test attempt. Never creates an Account,
// session, assertion, assurance or passing correlation state.
import { eq } from 'drizzle-orm';
import { authSchema, openAuthDatabase } from '@ensemus/database/auth';
import {
  nativeSamlRedirect,
  parseSamlIntent,
  SAML_BROWSER_PREFIX,
} from '../../packages/auth/src/saml-browser-binding';
import { urls } from './stack';
import { isGeneratedBrowserSamlRequest } from './browser-saml-provider';
export async function expireGeneratedSamlCorrelation(id: string, idpURL: string, issuer: string) {
  const redirect = nativeSamlRedirect(idpURL);
  if (!redirect || !isGeneratedBrowserSamlRequest(idpURL, 'GET', 'document'))
    throw new Error('GENERATED_SAML_REQUEST_REQUIRED');
  const database = openAuthDatabase(urls.auth());
  try {
    const row = await database.db.query.verifications.findFirst({
        where: (row, { eq }) => eq(row.id, id),
      }),
      intent = row ? parseSamlIntent(row.value) : null;
    if (
      !row ||
      row.identifier !== `${SAML_BROWSER_PREFIX}${redirect.relaySha256}` ||
      !intent ||
      intent.mode !== 'signin' ||
      intent.phase !== 'prepared' ||
      intent.requestId !== redirect.requestId ||
      intent.issuer !== issuer
    )
      throw new Error('GENERATED_SAML_CORRELATION_REQUIRED');
    await database.db
      .update(authSchema.verification)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSchema.verification.id, id));
  } finally {
    await database.close();
  }
}
