// Opt-in isolated gate. It never closes the shared integration database or fast-forwards cooldown.
import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/integration/auth-restore/**/*.gate.ts'],fileParallelism:false,maxWorkers:1,testTimeout:60000,hookTimeout:120000}});
