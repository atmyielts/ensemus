#!/usr/bin/env node
import { accessSync, constants, readFileSync, statSync } from 'node:fs';

let config;
try {
  config = JSON.parse(readFileSync(0, 'utf8'));
  if (!config?.services || Object.keys(config.services).length === 0) throw new Error();
} catch {
  console.error('Pass the output of docker compose config --format json on stdin.');
  process.exit(1);
}

const required = new Set(
  Object.values(config.services).flatMap((service) =>
    (service.secrets ?? []).map((secret) => (typeof secret === 'string' ? secret : secret.source)),
  ),
);
let invalid = 0;
for (const name of required) {
  const file = config.secrets?.[name]?.file;
  if (!file) continue;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error();
    accessSync(file, constants.R_OK);
  } catch {
    console.error(`Compose secret ${name} needs a readable, nonempty file.`);
    invalid += 1;
  }
}
if (invalid > 0) process.exit(1);
console.log('Required Compose secret files are present and readable.');
