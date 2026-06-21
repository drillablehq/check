# The `verify`→`search` bridge — implementation spec

The bridge recovers a verdict for a claim that `verify` **abstained** on, by finding the record the
claim is about and running an **executable value-comparison** against it. It is the single unlock
that widens Check from the executable lane to the catalog lane.

**The one honesty invariant:** the bridge turns an `Abstain` into a verdict *only* via an executable
comparison (`core/compare`) against a **cited record field**. Every other path stays `Abstain`. So a
bridge verdict carries the same floor-locus grounding (`DOCUMENT`/`INTERNAL`) as a primary one — it
is never "search returned something relevant."

---

## Where it hooks into the existing abstain path

Grounded in `core/verify/core_verify/verdict.py`: an `Abstain` already carries a `kind`. That field
*is* the gate.

```python
# in the verify receipt assembly, post-process each result:
if isinstance(v, Abstain) and v.kind in ("no-oracle", "no-data"):
    v = bridge(claim, domain) or v          # recoverable: no oracle was REACHED for this claim
# leave untouched:
#   Abstain(kind="absent" | "unperformable")  → no fact of the matter; recovering would be dishonest
#   Verified / Corrected / Pass / Fail / Distribution → already grounded
```

So the bridge fires on exactly the abstains that mean *"a floor exists but we didn't reach it"* —
never on the abstains that mean *"there is no fact here."* That distinction is already modeled; the
bridge just keys on it.

---

## Mechanism (each step fail-closed)

Input: `Claim{subject, attribute, asserted}` + routed `domain`. (Parsing one claim string into
`{subject, attribute, asserted}` is the bridge's small front-end — far smaller than full-document
extraction, and reusable by it later.)

- **B1 — Resolve the referent record.** `search(domain, subject)`, gated on **subject identity**
  (reuse the deterministic top-hit resolver from `gateway/src/ask.ts`). The record must *be about the
  subject*, not merely score near it. Ambiguous / weak match → **stay Abstain**.
- **B2 — Locate the comparable field.** Map the claim's `attribute` to a structured field on the
  record (`"is rum-based"` → `base_spirit`). No corresponding field, or the value isn't typed/
  extractable → **stay Abstain**. (Never compare against an arbitrary field.)
- **B3 — Compare (the referee).** Project into the `core/compare` seam and run it on that one axis:
  ```python
  diff = core_compare.compare(
      {"asserted": {attr: norm(asserted)}, "record": {attr: norm(record_value)}}, axes=[attr])
  ```
  The record is the cited authority (`Locus.DOCUMENT`/`INTERNAL`), so a difference resolves
  *directionally*:
  - not `differ` → **`Verified(value=record_value, source=record)`**
  - `differ`     → **`Corrected(was=asserted, value=record_value, source=record)`**
  - `core/compare`'s built-in **value-abstention** (a non-grounded / value-laden axis — "best",
    "worth it", U2b) → **stay Abstain**.
- **B4 — Closed-world guard.** A membership / negation claim (`"X contains Y"`, `"X is not Z"`) can
  be `Corrected` by *absence* only if the record's field is flagged **exhaustive**. Otherwise absence
  ≠ contradiction → **stay Abstain**. (The classic closed-world trap — absence of evidence isn't
  evidence of absence.)

`norm()` is a thin typed layer the bridge adds over `core/compare`'s structural diff:
string-canonical (case/space/alias), **numeric-with-tolerance** (reuse the chemistry measured-value
containment rule, not exact-string), set-membership. `core/compare` gives the structural `differ` /
`spread`; `norm()` + the type decides the verdict.

---

## Verdict mapping & provenance

The bridge emits the **same `Verdict` types** — it just sources them differently. Tag provenance so
the receipt stays honest about *how* the verdict was reached:

- `via = "bridge:search+compare"` (vs `verify:recall-traps` / `verify:grounding`)
- `independence = "catalog-record"`
- receipt summary increments **`recovered_by_bridge`** — the throttle, measured per run.

---

## What's already built vs genuinely new

| Step | Reuses | New? |
| --- | --- | --- |
| Hook on `Abstain(kind∈{no-oracle,no-data})` | `core/verify` verdict types | wiring |
| B1 subject resolution | `search` + `ask.ts` top-hit resolver | wiring |
| B3 comparison + value-abstention | **`core/compare`** | wiring |
| Emit `Verified`/`Corrected`/`Abstain` | `core/verify` constructors | wiring |
| B2 attribute→field map | — | **new (small)** |
| `norm()` typed comparator (string/number-tolerance/set) | chemistry measured-value rule | **new (small)** |
| Single-claim `{subject,attribute,asserted}` parse | — | **new (small)** |
| B4 closed-world / exhaustiveness flag | — | **new (small)** |

The bridge is **mostly composition of cores that already exist** (`compare`, `verify`, `search`, the
resolver). The genuinely new surface is small and well-bounded — which is the argument for building
it first.

---

## Negative-known-answer locks (the tests that keep it honest)

Each guard gets a test whose *known answer is "stay abstained / corrected"* — verify-the-verifier:

1. `Margarita base = "rum"` → **corrected → tequila** (record has `base_spirit`). The happy path.
2. A subject whose only matching record is **prose with no structured field** → **stays abstained**
   (B2 fail-closed — the catalog gap remains a gap, not a false pass).
3. `"a Negroni contains vodka"` against a **non-exhaustive** ingredient list → **stays abstained**
   (B4 — can't prove absence).
4. A **value-laden** attribute (`"the best base spirit"`) → **stays abstained** (`core/compare`'s
   U2b refusal).
5. A near-miss subject (`search` returns a *different* cocktail) → **stays abstained** (B1 identity
   gate), never compared against the wrong record.
6. Numeric within tolerance (`"standard deduction is $13,851"` vs `13,850` ± rounding) → policy call:
   `verified` or `corrected` per the field's declared tolerance — pinned by the chemistry rule, not
   string-exact.
