import { defineConfig } from 'drizzle-kit';

// Generates table DDL only. Roles, grants and RLS live in reviewed custom SQL migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/schema.ts',
    './src/schema-work.ts',
    './src/schema-integrations.ts',
    './src/schema-ai.ts',
    './src/schema-ai-inputs.ts',
    './src/schema-ai-child-inputs.ts',
    './src/schema-ai-main-inputs.ts',
    './src/schema-ai-read-authority.ts',
    './src/schema-ai-delegated-inputs.ts',
    './src/schema-ai-source-closures.ts',
    './src/schema-artifact-authority.ts',
    './src/schema-knowledge.ts',
    './src/schema-artifact-provenance.ts',
    './src/schema-client-access.ts',
    './src/schema-product.ts',
  ],
  out: './migrations',
  casing: 'snake_case',
});
