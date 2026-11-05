import { defineConfig } from 'drizzle-kit';

// Generates table DDL only. Roles, grants and RLS live in reviewed custom SQL migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  casing: 'snake_case',
});
