// For the support desk's command only (lint blocks the web tier). `ensemus_support` reaches the ticket tables
// and nothing else in the database, which is what "no default access to content" rests on (ADR-032 D8).
import { openDatabase, type EnsemusDrizzle } from './connection';

export type { EnsemusDrizzle };

export function openSupportDatabase(url: string) {
  return openDatabase(url, { max: 1 });
}
