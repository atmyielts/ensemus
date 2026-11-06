// For @ensemus/application/saas only (lint blocks this elsewhere). What a person may still do in a tenant that
// is read-only, suspended or leaving (ADR-032 D5). Everything else goes through withTenantTx.
export { accountContextOf, withAccountTx } from './tenant';
