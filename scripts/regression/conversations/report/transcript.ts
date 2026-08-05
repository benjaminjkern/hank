// Per-persona JSONL transcript. One line per turn, appended live (via the
// persona loop's onTurn callback) so a crash/halt still leaves a durable
// record. Each line is the full TurnRecord, including the raw VisibleTurn.

import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

import type { TurnRecord } from "../agent/personaAgent";

export function appendTurn(path: string, rec: TurnRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}
