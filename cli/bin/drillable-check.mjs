#!/usr/bin/env node
// drillable-check — grounds the factual claims in your files against the Drillable corpus.
// "npm audit for claims." THIN CLIENT: it ships text to the Drillable Check engine, which does the
// hard part (claim extraction → verify → the verify→search fallback → locate each claim to file:line)
// and returns a per-claim receipt. Improvements ship server-side; this client never needs updating.
//
//   npx drillable-check docs/**/*.md      # audit specific files
//   npx drillable-check --diff            # audit only files changed vs the base ref (CI default)
//   npx drillable-check --json            # machine output
//
// THE GATE (exit codes):
//   0  clean — no CORRECTED claims.
//   1  at least one CORRECTED claim — a fact the corpus positively contradicts. THIS is the gate.
//   ABSTENTIONS NEVER FAIL THE BUILD: the corpus not holding a referee for a claim is not a defect
//   (it's logged as demand). Fail-only-on-corrected = near-zero-false-positive gating, which is the
//   whole reason this is safe to put in CI.
//   Infra/auth error → exit 0 + warning by default (a Drillable outage must not wedge your CI).
//   Pass --fail-on-error to make an unreachable engine fail instead.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = {
  paths: [], diff: false, json: false, failOnError: false,
  failOn: "corrected",
  base: process.env.GITHUB_BASE_REF || "origin/main",
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--diff") opt.diff = true;
  else if (a === "--json") opt.json = true;
  else if (a === "--fail-on-error") opt.failOnError = true;
  else if (a === "--fail-on") opt.failOn = argv[++i];
  else if (a === "--base") opt.base = argv[++i];
  else if (!a.startsWith("-")) opt.paths.push(a);
}

const ENDPOINT = process.env.DRILLABLE_CHECK_URL ?? "https://mcp.drillable.com/check";
const KEY = process.env.DRILLABLE_KEY ?? "";
const FAIL_ON = opt.failOn.split(",").map((s) => s.trim());

// 1) collect target files (changed-vs-base in --diff mode; else the given paths)
let files = opt.paths;
if (opt.diff) {
  try {
    files = execSync(`git diff --name-only ${opt.base}...HEAD`, { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    console.error(`drillable-check: could not diff against ${opt.base} (in CI, checkout with fetch-depth: 0).`);
    process.exit(opt.failOnError ? 2 : 0);
  }
}
if (!files.length) { console.error("drillable-check: no files to check (pass paths or --diff)."); process.exit(0); }

// 2) call the engine — it extracts claims, grades them, and returns receipts with file:line
let receipt;
try {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({
      mode: "receipt",
      files: files.map((p) => ({ path: p, content: read(p) })).filter((f) => f.content != null),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  receipt = await res.json();
} catch (e) {
  console.error(`drillable-check: engine unreachable (${e.message}). Not failing the build.`);
  process.exit(opt.failOnError ? 2 : 0); // an outage is ours, not your red build
}

const results = receipt?.results ?? [];
const pick = (v) => results.filter((r) => r.verdict === v);
const corrected = pick("corrected"), verified = pick("verified"), abstained = pick("abstained");

// 3) render
if (opt.json) {
  console.log(JSON.stringify({ summary: { verified: verified.length, corrected: corrected.length, abstained: abstained.length }, results }, null, 2));
} else {
  for (const c of corrected) {
    console.log(`✗ ${c.path}:${c.line ?? "?"}  "${c.was ?? c.asserted}" → ${c.value}  (${c.source ?? c.independence ?? "drillable"})`);
  }
  console.log(`\n${files.length} file(s) · ${results.length} claim(s) · ${verified.length} verified · ${corrected.length} corrected · ${abstained.length} abstained`);
  if (abstained.length) console.log(`note: ${abstained.length} abstained = no referee in the corpus (logged as demand, not a failure).`);
}

// 4) the gate
process.exit(FAIL_ON.some((v) => pick(v).length > 0) ? 1 : 0);

function read(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }
