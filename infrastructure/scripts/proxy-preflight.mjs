#!/usr/bin/env node
// Warns before starting about proxy settings that cannot be right (ADR-037 D9). It refuses nothing: a guess
// must not stop a deployment, so it exits 0 whatever it finds, and 1 only if it cannot read the file.
//
//   node infrastructure/scripts/proxy-preflight.mjs [env-file]    (defaults to .env)
import { readFileSync } from 'node:fs';
import { describeFinding, parseEnvFile, proxyFindings } from './proxy-preflight-rules.mjs';

const file = process.argv[2] ?? '.env';

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.error(`Could not read ${file}.`);
  process.exit(1);
}

const findings = proxyFindings(parseEnvFile(text));
for (const finding of findings) console.log(describeFinding(finding));
console.log(`Checked the proxy settings in ${file}: ${findings.length} warning(s).`);
