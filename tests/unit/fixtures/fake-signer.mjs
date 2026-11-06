#!/usr/bin/env node
// A stand-in for whatever holds a real release key. It lives with the tests and nothing that ships
// imports it. It reads what to sign on standard input and signs with a generated key the test names,
// and the behaviours are the ways a real signer can let a release script down.
//
// createCommandSigner runs a command with no arguments and no shell, and on Windows a .mjs file is not
// something the system can run. So the tests name Node itself as the command and load this file through
// NODE_OPTIONS, which works the same everywhere. It always exits before Node would read what is left of
// standard input as a script.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const keyFile = process.env.ENSEMUS_TEST_FAKE_SIGNER_KEY_FILE;
const behaviour = process.env.ENSEMUS_TEST_FAKE_SIGNER_BEHAVIOUR ?? 'sign';
const secret = process.env.ENSEMUS_TEST_FAKE_SIGNER_SECRET ?? '';

const input = readFileSync(0);
const signature = () =>
  sign(null, input, createPrivateKey(readFileSync(keyFile))).toString('base64');

// Direct writes, because a write to a pipe through process.stderr may not finish before process.exit.
switch (behaviour) {
  case 'sign':
    writeFileSync(1, `${signature()}\n`);
    process.exit(0);
    break;
  case 'exit-nonzero':
    process.exit(3);
    break;
  case 'garbage':
    writeFileSync(1, 'this is not a signature!!\n');
    process.exit(0);
    break;
  case 'too-short':
    writeFileSync(1, `${Buffer.from('short').toString('base64')}\n`);
    process.exit(0);
    break;
  case 'secret-on-stderr-and-fail':
    writeFileSync(2, `could not unlock the key with ${secret}\n`);
    process.exit(1);
    break;
  case 'secret-on-stdout-and-fail':
    writeFileSync(1, `could not unlock the key with ${secret}\n`);
    process.exit(1);
    break;
  case 'secret-instead-of-signature':
    writeFileSync(1, `${secret}\n`);
    process.exit(0);
    break;
  case 'secret-on-stderr-and-sign':
    writeFileSync(2, `unlocked the key with ${secret}\n`);
    writeFileSync(1, `${signature()}\n`);
    process.exit(0);
    break;
  case 'hang':
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    process.exit(0);
    break;
  default:
    process.exit(64);
}
