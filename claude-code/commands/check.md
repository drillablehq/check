---
description: Audit a file, glob, or the current diff against the Drillable corpus — the "npm audit" for claims. Extracts factual claims, grades each via drillable verify (receipt mode), and prints verified / corrected / abstained.
argument-hint: "[path or glob; defaults to the working-tree diff]"
---

You are running a **grounding audit** — the on-demand, batch counterpart to the always-on Stop hook. Same engine (`drillable verify`), different trigger: this one audits an artifact that already exists.

**Target:** $ARGUMENTS — if empty, audit the claims introduced by the current `git diff`.

Steps:

1. Read the target. Extract the **discrete, checkable factual claims** — numbers, named facts, definitions, "X is Y" assertions. Skip opinions, instructions, and the agent's own code/runtime behavior (the corpus does not cover those).
2. For each claim, call the **`drillable` `verify`** tool in **receipt mode** (`claims: [...]`), passing your own `asserted` value so the corpus GRADES it, not merely grounds it. Use recognition-free `op` + `params` where the claim is computable (the strongest, hard-guarantee form); otherwise catalog `claim` + `asserted`.
3. Print a table — claim · verdict (✅ verified / ✏️ corrected / — abstained) · drilled value · source.
4. Summarize: N verified, **N corrected (list these first — they are the catches)**, N abstained.

Rules:

- **Never assert a claim is correct that came back `abstained`.** Abstention means the corpus has no referee for that claim — it is now logged as demand, not a pass. Treating abstain as "verified" is the exact overclaim this product exists to prevent.
- The receipt is the evidence; your prose is not. A claim with no receipt line is unverified — say so.
