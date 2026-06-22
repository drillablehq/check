#!/usr/bin/env node
// drillable-check — catch the dependencies that don't exist. "the half npm audit can't do."
// Reads the lockfiles you already commit and grades every package against the LIVE registry +
// advisory DB (OSV): a hallucinated name, a slop/typo-squat, an unpublished version, or a known CVE
// fails the build before it ships. THIN CLIENT: it ships your manifests to the Drillable Check engine,
// which resolves each package live and returns a per-package receipt — each verdict drilling to the
// registry/OSV URL that decided it (nothing guessed). Improvements ship server-side; never updates.
//
//   npx drillable-check                   # check this repo's manifests (auto-discovered in CWD)
//   npx drillable-check package.json      # check a specific manifest
//   npx drillable-check --diff            # check only manifests changed vs the base ref (CI default)
//   npx drillable-check --json            # machine output
//
// Grades npm (package.json, package-lock.json), PyPI (requirements.txt, pyproject.toml), and crates
// (Cargo.toml) today; other ecosystems abstain (never a false denial). Prose / factual-claim grading
// is roadmap, not shipped — see README.
//
// THE GATE (exit codes):
//   0  clean — nothing CORRECTED.
//   1  at least one CORRECTED package — a name/version the registry or OSV positively flags. THE gate.
//   ABSTENTIONS NEVER FAIL THE BUILD: an uncovered ecosystem or unreachable registry is not a defect
//   (it's logged as demand). Fail-only-on-corrected = near-zero-false-positive gating, which is the
//   whole reason this is safe to put in CI.
//   Infra/auth error → exit 0 + warning by default (a Drillable outage must not wedge your CI).
//   Pass --fail-on-error to make an unreachable engine fail instead.

import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = {
  paths: [], diff: false, json: false, failOnError: false, help: false,
  failOn: "corrected",
  base: process.env.GITHUB_BASE_REF || "origin/main",
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") opt.help = true;
  else if (a === "--diff") opt.diff = true;
  else if (a === "--json") opt.json = true;
  else if (a === "--fail-on-error") opt.failOnError = true;
  else if (a === "--fail-on") opt.failOn = argv[++i];
  else if (a === "--base") opt.base = argv[++i];
  else if (!a.startsWith("-")) opt.paths.push(a);
}

// --help short-circuits before any file collection or network call (a bare `--help` must never
// auto-discover manifests and hit the engine). Keep this usage block in sync with the header above.
const HELP = `drillable-check — catch the dependencies that don't exist. "the half npm audit can't do."
Grades the lockfiles you already commit against the live registry + OSV advisory DB; each verdict
drills to the registry/OSV URL that decided it (nothing guessed). Checking is server-side — thin client.

Usage:
  npx drillable-check                 check this repo's manifests (auto-discovered in the CWD)
  npx drillable-check package.json    check specific manifest(s), or a directory of them
  npx drillable-check --diff          check only manifests changed vs the base ref (the CI default)
  npx drillable-check --json          machine-readable output

Options:
  --diff               only manifests changed vs --base (needs git history; fetch-depth: 0 in CI)
  --base <ref>         base ref for --diff (default: $GITHUB_BASE_REF or origin/main)
  --json               emit JSON instead of the text report
  --fail-on <v,..>     comma-separated verdicts that fail the build (default: corrected)
  --fail-on-error      treat an unreachable engine as a failure (exit 2) instead of passing
  -h, --help           show this help and exit

Graded today: npm (package.json, package-lock.json) · PyPI (requirements.txt, pyproject.toml) ·
crates (Cargo.toml). Other ecosystems abstain — never a false denial.

Exit codes:
  0   clean — nothing corrected (also an unreachable engine, unless --fail-on-error)
  1   at least one corrected package — a name/version the registry or OSV positively flags (the gate)
  2   engine unreachable or --diff failed, and --fail-on-error was set`;
if (opt.help) { console.log(HELP); process.exit(0); }

const ENDPOINT = process.env.DRILLABLE_CHECK_URL ?? "https://mcp.drillable.com/check";
const KEY = process.env.DRILLABLE_KEY ?? "";
const FAIL_ON = opt.failOn.split(",").map((s) => s.trim());

// Dependency manifests the engine grades today (verified live against /check) — keep in sync with
// what /check actually accepts: npm (package.json, package-lock.json), PyPI (requirements.txt,
// pyproject.toml), crates (Cargo.toml). Other ecosystems abstain server-side, never a false denial.
const MANIFESTS = ["package.json", "package-lock.json", "requirements.txt", "pyproject.toml", "Cargo.toml"];
const isManifest = (p) => MANIFESTS.includes(basename(p));
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const discover = (dir) => MANIFESTS.map((m) => join(dir, m)).filter(existsSync); // shallow, CWD only

// 1) collect target manifests:
//    --diff      → manifests changed vs the base ref (the CI default)
//    paths given → those paths, each directory (e.g. `.`) expanded to the manifests inside it
//    neither     → auto-discover manifests in the CWD (the headline `npx drillable-check`)
let files;
if (opt.diff) {
  try {
    files = execSync(`git diff --name-only ${opt.base}...HEAD`, { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    const tail = opt.failOnError ? "Failing the build (--fail-on-error)." : "Not failing the build.";
    console.error(`drillable-check: could not diff against ${opt.base} (in CI, checkout with fetch-depth: 0). ${tail}`);
    process.exit(opt.failOnError ? 2 : 0);
  }
} else if (opt.paths.length) {
  files = opt.paths.flatMap((p) => (isDir(p) ? discover(p) : [p]));
} else {
  files = discover(".");
}

// The engine only grades dependency manifests, so drop everything else here. This makes a docs-only
// run (or `drillable-check README.md`) a clean no-op instead of a confusing engine error.
files = files.filter(isManifest);
if (!files.length) {
  console.error(`drillable-check: no dependency manifest found here (looked for ${MANIFESTS.join(", ")}) — nothing to check.`);
  process.exit(0);
}

// 2) read each manifest; if nothing is actually readable, that's a no-op, not an engine error
//    (an empty files[] is what the endpoint 400s on — short-circuit so we never mislabel it).
const payload = files.map((p) => ({ path: p, content: read(p) })).filter((f) => f.content != null);
if (!payload.length) {
  console.error("drillable-check: nothing to check (could not read any manifest).");
  process.exit(0);
}

// 3) call the engine — it parses the declared dependencies, resolves each live, and returns receipts
let receipt;
try {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ mode: "receipt", files: payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  receipt = await res.json();
} catch (e) {
  // Message must match the exit code: only say "not failing the build" when we actually exit 0.
  const tail = opt.failOnError
    ? "Failing the build (--fail-on-error)."
    : "Not failing the build — an outage is ours, not your red build.";
  console.error(`drillable-check: engine unreachable (${e.message}). ${tail}`);
  process.exit(opt.failOnError ? 2 : 0);
}

const results = receipt?.results ?? [];
const notes = Array.isArray(receipt?.notes) ? receipt.notes : [];
const pick = (v) => results.filter((r) => r.verdict === v);
const corrected = pick("corrected"), verified = pick("verified"), abstained = pick("abstained");

// 4) render. Verdicts on the wire are verified | corrected | abstained; we surface "abstained" as
//    "no record" to match the label on drillable.com (the JSON keeps the raw verdict for tooling).
if (opt.json) {
  console.log(JSON.stringify({ summary: { verified: verified.length, corrected: corrected.length, abstained: abstained.length }, notes, results }, null, 2));
} else {
  for (const c of corrected) {
    const where = c.line != null ? `${c.path}:${c.line}` : c.path;
    const kind = c.kind ? ` [${c.kind}]` : "";
    console.log(`✗ ${where}  ${c.was ?? c.asserted ?? "?"}${kind} → ${c.value ?? "flagged"}  (${c.source ?? c.independence ?? "drillable"})`);
  }
  console.log(`\n${payload.length} file(s) · ${results.length} package(s) · ${verified.length} verified · ${corrected.length} corrected · ${abstained.length} no record`);
  // Surface the engine's structural notes (skipped/unsupported manifests, dep-count caps). Without
  // this a server-side skip prints as a clean "0 package(s)" — a false all-clear. Never hide it.
  for (const n of notes) console.log(`note: ${n}`);
  if (abstained.length) console.log(`note: ${abstained.length} with no record = uncovered ecosystem or registry unreachable (logged as demand, not a failure).`);
}

// 5) the gate
process.exit(FAIL_ON.some((v) => pick(v).length > 0) ? 1 : 0);

function read(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }
