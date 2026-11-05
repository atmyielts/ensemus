import { join } from 'node:path';
import { repoRoot } from '../helpers/stack';

export const CORPUS_DIR = 'tests/replay/histories';
export const WORKFLOWS = join(repoRoot, 'packages/workflows/src/workflows.ts');
export const FAILURE_CONVERTER = join(repoRoot, 'packages/workflows/src/failure-converter.ts');

/** Encrypts only the corpus's own synthetic IDs. It protects nothing, and is safe to commit. */
export const REPLAY_KEY = Buffer.alloc(32, 7).toString('base64');
