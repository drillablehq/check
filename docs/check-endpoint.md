# `/check` — the Drillable Check engine contract

`/check` is the one server-side endpoint every surface calls (CLI, GitHub Action, the Claude Code
hook, the web). Give it text; it returns a **receipt** — a per-claim verdict (`verified` /
`corrected` / `abstained`) with a source and a `file:line`.

**Where it lives:** server-side, in the gateway (alongside the existing `verify` machinery). This
repo only *calls* it. **What exists today:** `verify` (single + receipt, recognition-free + catalog)
and `search`. **What `/check` adds:** claim **extraction** over free text, claim **location**, and
the **`verify`→`search` bridge**.

---

## The pipeline

```
text ─▶ 1 EXTRACT ─▶ 2 ROUTE ─▶ 3 GRADE ─▶ 4 BRIDGE ─▶ 5 LOCATE+ASSEMBLE ─▶ receipt
        (NEW)         (exists)   (exists)   (NEW)        (NEW: line bookkeeping)
```

1. **Extract (NEW).** Segment the text; propose candidate factual claims — each a `{span,
   claim_text, asserted_value, candidate_domains}`. Recall-oriented. Skips opinions, instructions,
   and code behavior. Emits `extracted` and `skipped` counts.
2. **Route (exists).** Map each candidate to domain(s) + verb — recognition-free `op` if computable,
   else catalog `claim`. This is the gateway's existing routing.
3. **Grade (exists).** Run the existing `verify` receipt engine per claim → `verified` / `corrected`
   / `abstained`, with `value`, `was`, `source`, `independence`.
4. **Bridge (NEW).** For each `abstained`, try `search` in the routed domain; if a record with a
   **comparable grounded value** is found, run a value-comparison referee and upgrade to
   `verified`/`corrected`. Otherwise the abstain stands (logged as demand). *See the honesty gate
   below — a search hit alone is never a verdict.*
5. **Locate + assemble.** Attach `path` / `line` / `span`; build and (optionally) sign the receipt.

---

## The two honesty gates (the reason this isn't "just an LLM")

**Gate 1 — extraction PROPOSES, the referee DISPOSES.** Extraction may be model-driven, but it only
*finds candidate claims* (a recall task). It never emits a verdict. Truth is decided exclusively by
the deterministic referee in stages 3–4. So extraction's failure modes are bounded:
- a *missed* claim → silently unchecked (incomplete coverage, like any linter — safe);
- a *spurious* claim → gets graded → abstains/verifies (no harm);
- a *mis-read asserted value* → the only real risk → mitigated by returning `span` + `claim_text`
  in every result, so any correction is auditable back to the exact text it read. Extraction
  fidelity is checkable against the span; the verdict is not extraction's to make.

**Gate 2 — the bridge upgrades an abstain only on a COMPARABLE GROUNDED VALUE.** A `search` hit is a
*candidate referee record*, not a verdict. The bridge must pull a **structured/extractable value**
from the matched record and run a value-comparison (executable equality / containment), exactly like
`verify`'s catalog match. If the record has no comparable grounded value (unstructured prose only),
the claim **stays abstained** — it does not become `verified` because "search found something." This
is what stops the bridge from reintroducing fuzzy-retrieval-as-truth.

> Worked example: claim `"a Margarita is rum-based"` → `verify` abstains → bridge `search`es
> `cocktail` → finds the `margarita` record with `base_spirit: "tequila"` → compares `rum` ≠
> `tequila` → **`corrected` → tequila**, citing the record. If the record had only prose and no
> `base_spirit` field, it would stay `abstained`.

---

## Request

```
POST /check
Authorization: Bearer <DRILLABLE_KEY>
Content-Type: application/json
```
```jsonc
{
  "mode": "receipt",                         // only mode for now (future: "summary")
  // supply EITHER files[] OR text:
  "files": [ { "path": "README.md", "content": "…" } ],
  "text": "…",                                // single blob; "path" optional
  "domains": ["cocktail", "tax"],             // optional: restrict routing
  "scope": { "changedLines": { "README.md": [[10, 42]] } },  // optional: only claims in these line ranges
  "options": {
    "max_claims": 200,                        // bound cost; surplus → skipped (reported)
    "no_log": false                           // privacy: suppress demand logging of this request (paid tier)
  }
}
```

## Response

Builds directly on the existing `verify` receipt — same `results[]` shape, plus `path`/`line`/
`span`/`claim_text` and richer `summary`.

```jsonc
{
  "receipt": {
    "receipt_id": "…",
    "ts": "2026-06-21T…Z",
    "corpus_version": "0.1.2",
    "results": [
      {
        "path": "README.md",
        "line": 12,
        "span": [340, 388],                   // char offsets in that file's content
        "claim_text": "A Margarita is rum-based",   // what extraction read (audit trail for Gate 1)
        "asserted": "rum",
        "verdict": "corrected",               // verified | corrected | abstained
        "via": "bridge:search+compare",       // verify:recall-traps | verify:grounding | bridge:search+compare
        "value": "tequila",                   // the drilled truth
        "was": "rum",
        "source": { "domain": "cocktail", "record_id": "margarita", "citation": "…" },
        "independence": "catalog-record",     // executable-oracle | catalog-record | …
        "confidence": "high"
      }
    ],
    "summary": {
      "extracted": 9, "skipped": 2, "claims": 7,
      "verified": 2, "corrected": 1, "abstained": 4,
      "recovered_by_bridge": 1                 // abstains the bridge rescued (the throttle, measured)
    },
    "signature": null                          // optional attestation over results[]
  }
}
```

Clients gate on `summary` / per-result `verdict` themselves (the CLI fails on `corrected`). The
endpoint never decides pass/fail — it only grades.

---

## Cross-cutting

- **Determinism.** Grading (stages 3–4) is deterministic given the extracted claim — executable
  referees and value-comparison, not generation. The only non-deterministic stage is extraction, and
  it can't emit a verdict (Gate 1). Same doc → same verdicts modulo extraction recall.
- **Privacy / demand.** `/check` ingests whole documents, which may carry PII — a sharper exposure
  than single `verify` calls. Abstained claims are logged as demand by default, but `no_log: true`
  (and server-side redaction of the surrounding text — log only the normalized claim) is the paid
  no-log tier. Default posture must be conservative about what gets stored.
- **Cost / caching.** Extraction over large docs is the cost driver (per-turn for the hook, per-PR
  for CI). Bound with `max_claims`; cache by content hash so an unchanged file is free on re-run.
- **Auth / limits.** Bearer key; per-key rate + payload-size limits; `max_claims` caps fan-out.

---

## Build delta (what to actually build)

| Piece | Status | Notes |
| --- | --- | --- |
| `verify` (single + receipt) | **exists** | recognition-free op re-exec + catalog match |
| `search`, routing, demand sink, receipt+signature | **exists** | reuse as-is |
| **Extraction** (free text → located candidate claims) | **build** | the big new piece; recall-only, model-or-rules, audited by returned `span` |
| **The bridge** (`abstain`→`search`→value-compare) | **build** | the throttle-unlock; honesty-gated on a comparable grounded value |
| **Location** (claim → `file:line`) | **build** | falls out of extraction; newline bookkeeping |
| **`/check` HTTP route** | **build** | wraps the pipeline; the one endpoint every surface calls |

Two real new capabilities — **extraction** and **the bridge** — plus plumbing. Everything else is
the existing gateway, reused.
