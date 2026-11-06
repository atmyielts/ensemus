// ADR-037 D3 draws lines a running test cannot see: what a default install loads, what crosses Temporal,
// and which processes stay dark. main.ts and dispatcher.ts start on import and need Temporal, so what they
// must do is pinned from their source here. That they really start is left for a container run.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

const SKIPPED_FOLDERS = new Set(['node_modules', '.next', 'dist', 'generated', 'migrations']);

function sourcesUnder(folder: string): string[] {
  const start = join(repoRoot, folder);
  if (!existsSync(start)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(full);
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        found.push(relative(repoRoot, full).replaceAll('\\', '/'));
      }
    }
  };
  walk(start);
  return found;
}

// Each takes a module name, so a line of source can be asked about one thing at a time.
const loads = (specifier: string) => [
  new RegExp(`\\bfrom\\s*['"]${specifier}['"]`),
  new RegExp(`\\bimport\\s*['"]${specifier}['"]`),
  new RegExp(`\\bimport\\s*\\(\\s*['"]${specifier}['"]`),
  new RegExp(`\\brequire\\s*\\(\\s*['"]${specifier}['"]`),
];
const anyLoad = (specifier: string) => (source: string) =>
  loads(specifier).some((form) => form.test(source));

const OPENTELEMETRY = '@opentelemetry/[^\'"]+';
// By package name, or by a relative path into the package. Takes in tracing-sdk as well.
const TELEMETRY_TRACING = '(?:@ensemus/telemetry/|[^\'"]*telemetry/src/)tracing[^\'"]*';
const loadsOpenTelemetry = anyLoad(OPENTELEMETRY);
const loadsTelemetryTracing = anyLoad(TELEMETRY_TRACING);

/** A load that runs when the file does. `import type` is erased, so it loads nothing. */
const STATIC_SDK_LOAD =
  /(?:^|\n)\s*(?:(?:import|export)\s+(?!type\b)[^'";]*?from\s*|import\s*)['"][^'"]*tracing-sdk['"]/;
const REQUIRED_SDK_LOAD = /\brequire\s*\(\s*['"][^'"]*tracing-sdk['"]/;
const loadsSdkStatically = (source: string) =>
  STATIC_SDK_LOAD.test(source) || REQUIRED_SDK_LOAD.test(source);

/** Anything that would mean a process that must stay dark had been wired up. */
const NAMES_TRACING = /tracing|withSpan|opentelemetry|ENSEMUS_OTEL/i;

describe('these checks can fail', () => {
  it('sees each way of loading OpenTelemetry', () => {
    for (const line of [
      "import { trace } from '@opentelemetry/api';",
      'import type { Span } from "@opentelemetry/api";',
      "export * from '@opentelemetry/core';",
      "import '@opentelemetry/sdk-trace-node';",
      "await import('@opentelemetry/api');",
      "require('@opentelemetry/api');",
    ]) {
      expect(loadsOpenTelemetry(line), line).toBe(true);
    }
    expect(loadsOpenTelemetry('// see @opentelemetry/api for why')).toBe(false);
  });

  it('sees each way of reaching the tracing modules', () => {
    for (const line of [
      "import { withSpan } from '@ensemus/telemetry/tracing';",
      "import { startTracing } from '@ensemus/telemetry/tracing-sdk';",
      "await import('@ensemus/telemetry/tracing-sdk');",
      "import { withSpan } from '../../telemetry/src/tracing';",
    ]) {
      expect(loadsTelemetryTracing(line), line).toBe(true);
    }
    expect(loadsTelemetryTracing("import { createLogger } from '@ensemus/telemetry';")).toBe(false);
  });

  it('tells a load at startup from one that waits to be asked', () => {
    for (const line of [
      "import { startTracing } from '@ensemus/telemetry/tracing-sdk';",
      "import * as sdk from './tracing-sdk';",
      "import './tracing-sdk';",
      "export { redactSpan } from './tracing-sdk';",
      "export * from './tracing-sdk';",
      "import {\n  redactSpan,\n  startTracing,\n} from './tracing-sdk';",
      "const sdk = require('./tracing-sdk');",
    ]) {
      expect(loadsSdkStatically(line), line).toBe(true);
    }
    for (const line of [
      "const sdk = await import('@ensemus/telemetry/tracing-sdk');",
      "import type { Sdk } from './tracing-sdk';",
      '// Everything that sends a span lives in ./tracing-sdk, and is loaded only when asked.',
    ]) {
      expect(loadsSdkStatically(line), line).toBe(false);
    }
  });

  it('would catch a dark process that started naming tracing', () => {
    for (const line of [
      "import { withSpan } from '@ensemus/telemetry/tracing';",
      "import { activityTracing } from './activity-tracing';",
      'loadTracingConfig();',
      'process.env.ENSEMUS_OTEL_ENDPOINT;',
    ]) {
      expect(NAMES_TRACING.test(line), line).toBe(true);
    }
    // Both already appear in these files, and they are the logger and Temporal's own log settings.
    expect(NAMES_TRACING.test("import { createLogger } from '@ensemus/telemetry';")).toBe(false);
    expect(NAMES_TRACING.test("telemetryOptions: { logging: { filter: 'WARN' } },")).toBe(false);
  });
});

describe('the connector worker and the egress gateway stay dark', () => {
  // ADR-027 D5 gives them a network with no route out, and a collector on it would be a route out.
  it.each(['workers/workflow/src/connector-worker.ts', 'workers/workflow/src/egress-gateway.ts'])(
    '%s names no tracing',
    (file) => {
      expect(read(file)).not.toMatch(NAMES_TRACING);
    },
  );
});

describe('nothing crosses Temporal', () => {
  const workflowFiles = sourcesUnder('packages/workflows/src');

  it('finds the workflow package', () => {
    expect(workflowFiles).toContain('packages/workflows/src/workflows.ts');
  });

  it('no file in the workflow package loads OpenTelemetry', () => {
    expect(workflowFiles.filter((file) => loadsOpenTelemetry(read(file)))).toEqual([]);
  });

  it('no file in the workflow package loads the tracing modules', () => {
    expect(workflowFiles.filter((file) => loadsTelemetryTracing(read(file)))).toEqual([]);
  });

  it('the worker adds no workflow interceptor and builds no workflow code of its own', () => {
    const main = read('workers/workflow/src/main.ts');
    expect(main).not.toContain('workflowModules');
    expect(main).not.toContain('workflowsPath');
    expect(main).not.toContain('bundlerOptions');
  });
});

describe('a default install does not load the SDK', () => {
  const shipped = ['apps', 'packages', 'workers']
    .flatMap(sourcesUnder)
    .filter((file) => !/\.test\.tsx?$/.test(file));

  it('finds the code it is reading', () => {
    expect(shipped).toContain('packages/telemetry/src/tracing.ts');
    expect(shipped).toContain('workers/workflow/src/main.ts');
  });

  it('no shipped file imports tracing-sdk in a way that runs at startup', () => {
    expect(shipped.filter((file) => loadsSdkStatically(read(file)))).toEqual([]);
  });

  it.each([
    ['workers/workflow/src/main.ts', 'worker'],
    ['workers/workflow/src/dispatcher.ts', 'dispatcher'],
  ])('%s asks for the SDK only when tracing is on', (file, service) => {
    const source = read(file);
    const on = source.indexOf('.enabled');
    const sdk = source.indexOf("import('@ensemus/telemetry/tracing-sdk')");
    expect(source.indexOf('loadTracingConfig()')).toBeGreaterThan(-1);
    expect(on).toBeGreaterThan(source.indexOf('loadTracingConfig()'));
    expect(sdk).toBeGreaterThan(on);
    expect(source.slice(sdk)).toContain(`startTracing('${service}'`);
  });
});

describe('the worker', () => {
  const main = read('workers/workflow/src/main.ts');

  it('traces its Activities through the interceptor', () => {
    expect(main).toContain('interceptors: { activity: [activityTracing()] }');
  });

  it('installs the runtime first, so that a bad setting is logged safely', () => {
    const install = main.indexOf('Runtime.install(');
    expect(install).toBeGreaterThan(-1);
    expect(main.indexOf('loadTracingConfig()')).toBeGreaterThan(install);
    expect(main.indexOf('NativeConnection.connect(')).toBeGreaterThan(
      main.indexOf('loadTracingConfig()'),
    );
  });

  it('sends what it still holds only after it has stopped', () => {
    const run = main.indexOf('await worker.run()');
    expect(run).toBeGreaterThan(-1);
    expect(main.indexOf('.shutdown()')).toBeGreaterThan(run);
  });
});

describe('the dispatcher', () => {
  const dispatcher = read('workers/workflow/src/dispatcher.ts');

  it('wraps each delivery in a span holding its type and tenant, around the same deadline', () => {
    expect(dispatcher).toMatch(
      /withSpan\(\s*'dispatcher\.deliver',\s*\{ eventType: event\.eventType, organizationId: event\.organizationId \},\s*\(\) =>\s*connection\.withDeadline\(Date\.now\(\) \+ CALL_DEADLINE_MS, \(\) => deliver\(event\)\),?\s*\)/,
    );
  });

  it('sends what it still holds only after the loop has ended', () => {
    const loopEnds = dispatcher.indexOf('await connection.close()');
    expect(loopEnds).toBeGreaterThan(-1);
    expect(dispatcher.indexOf('.shutdown()')).toBeGreaterThan(loopEnds);
  });
});
