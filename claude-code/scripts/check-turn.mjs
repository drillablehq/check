#!/usr/bin/env node
// drillable-check — the Stop hook ("the rail").
//
// Fires when the agent finishes a turn. Ships the turn's text to Drillable Check; if anything
// comes back CORRECTED, blocks the stop so the agent revises BEFORE the user sees the wrong claim.
// This is the structural answer to the confident-wrong paradox: the harness checks every turn
// regardless of whether the (confident) model would ever choose to.
//
// Design: keep the hook THIN. The server does the hard part (claim extraction → verify →
// verify→search fallback → receipt), so the throttle lives where Drillable controls it and
// improvements ship without users reinstalling.
//
// Fail-OPEN: any error exits 0 and never blocks the user. A grounding tool must never become
// a liveness risk.
//
// CONTRACT BITS to confirm against https://code.claude.com/docs/en/hooks before publishing:
//   • Stop-hook stdin shape: { session_id, transcript_path, stop_hook_active, cwd, ... }
//   • Stop block semantics: emitting { "decision": "block", "reason": "..." } re-prompts the agent
//   • transcript JSONL row shape ({ message: { role, content[] } } assumed below)

import { readFileSync } from "node:fs";

const ENDPOINT = process.env.DRILLABLE_CHECK_URL ?? "https://mcp.drillable.com/check";
const KEY = process.env.DRILLABLE_KEY ?? "";

const quiet = () => process.exit(0); // silent, non-blocking exit

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  quiet();
}

// Loop guard: if we already blocked once this turn, let the agent stop for real.
if (input?.stop_hook_active) quiet();

// The assistant text is not passed inline — read the last assistant message from the transcript.
let text = "";
try {
  const lines = readFileSync(input.transcript_path, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i]);
    if (row?.message?.role === "assistant") {
      const c = row.message.content;
      text = Array.isArray(c)
        ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
        : String(c ?? "");
      break;
    }
  }
} catch {
  quiet();
}
if (!text.trim()) quiet();

// Thin call: the server extracts claims, verifies, runs the verify→search fallback, returns a receipt.
let receipt;
try {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ text, mode: "receipt" }),
  });
  receipt = await res.json();
} catch {
  quiet(); // endpoint down / offline → never block the user
}

const corrected = (receipt?.results ?? []).filter((r) => r.verdict === "corrected");
if (corrected.length === 0) quiet(); // nothing caught → stay silent, don't nag on verified/abstained

// Block the stop so the agent fixes the wrong claim THIS turn.
process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason:
      "Drillable Check corrected the following before you finalize — revise and re-state:\n" +
      corrected
        .map((c) => `• "${c.was ?? c.asserted}" → ${c.value} (${c.source ?? c.independence ?? "drillable"})`)
        .join("\n"),
  }),
);
process.exit(0);
