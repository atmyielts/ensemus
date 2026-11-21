// COMM-06: which seams are plugged in. Empty until M3 to M8 are merged, so today every scenario that
// needs one reports "blocked", and the gate says not proven. Only slice parity-wiring edits this file.
import type { ParitySeams } from './seams';

export const wiring: Partial<ParitySeams> = {};
