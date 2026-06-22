---
description: Audit a file, glob, or the current diff for factual-claim accuracy via the drillable MCP corpus (the prose claim lane — distinct from the dependency CLI). Extracts claims, grades each via drillable verify (receipt mode), and prints verified / corrected / no record.
argument-hint: "[path or glob; defaults to the working-tree diff]"
---

You are running a **grounding audit** — the on-demand, batch counterpart to the always-on Stop hook. Same engine (`drillable verify`), different trigger: this one audits an artifact that already exists.

> **Status / scope.** This is the **prose claim-grading lane**: it runs entirely through the `drillable` MCP corpus (~60 reference domains), *not* the lockfile-only `/check` HTTP endpoint. It is the roadmap direction of Check (see [README](../../README.md) → "claims beyond dependencies"); the always-on Stop-hook counterpart is still parked. For dependency / lockfile checking — the shipped product — use the CLI: `npx drillable-check`.

**Target:** $ARGUMENTS — if empty, audit the claims introduced by the current `git diff`.

Steps:

1. Read the target. Extract the **discrete, checkable factual claims** — numbers, named facts, definitions, "X is Y" assertions. Skip opinions, instructions, and the agent's own code/runtime behavior (the corpus does not cover those).
2. For each claim, call the **`drillable` `verify`** tool in **receipt mode** (`claims: [...]`), passing your own `asserted` value so the corpus GRADES it, not merely grounds it. Use recognition-free `op` + `params` where the claim is computable (the strongest, hard-guarantee form); otherwise catalog `claim` + `asserted`.
3. Print a table — claim · verdict (✅ verified / ✏️ corrected / — no record) · drilled value · source.
4. Summarize: N verified, **N corrected (list these first — they are the catches)**, N no record.

Rules:

- **Never assert a claim is correct that came back `abstained`** (shown as "no record"). Abstention means the corpus has no referee for that claim — it is now logged as demand, not a pass. Treating abstain as "verified" is the exact overclaim this product exists to prevent.
- The receipt is the evidence; your prose is not. A claim with no receipt line is unverified — say so.
