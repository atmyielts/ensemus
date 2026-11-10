// For the operator's commands only (lint blocks the web tier). `ensemus_operator` writes the price list and
// reads what it needs across tenants, and cannot read anyone's work or log in until an operator lets it
// (ADR-032 D3). Nothing long-running holds this: a command opens it, does one thing, and closes it.
import { openDatabase, type EnsemusDrizzle } from './connection';

export type { EnsemusDrizzle };

export function openOperatorDatabase(url: string) {
  return openDatabase(url, { max: 1 });
}
