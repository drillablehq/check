# drillable-check

**Catch the dependencies that don't exist.** Reads the lockfiles you already commit and grades every
package against the **live** registry + advisory database — a hallucinated name, a slop/typo-squat, an
unpublished version, or a known CVE fails the build before it ships. Each verdict drills to the registry
or OSV URL that decided it; nothing is guessed.

It's the half `npm audit` doesn't do: audit catches known-*vulnerable* packages — it can't catch one
that **doesn't exist** (the name an AI assistant invented, that an attacker then registers).

```
npx drillable-check package.json     # check a manifest
npx drillable-check --diff            # only what changed vs the base ref (the CI default)
npx drillable-check --json            # machine output
```

## What it checks

| Ecosystem | Files | Graded |
| --- | --- | --- |
| npm | `package.json`, `package-lock.json` | name exists · version published · known CVEs (OSV) |
| PyPI | `requirements.txt`, `pyproject.toml` | name exists · `==`-pinned version published · known CVEs |
| crates | `Cargo.toml` | name exists · version published · known CVEs (RustSec/OSV) |

Each dependency returns **`verified`**, **`corrected`** (denied name / unpublished version / known CVE —
*the gate*), or **`abstained`** (uncovered ecosystem or unreachable registry — never a false denial).

## The gate

Exit `1` only when something is **`corrected`** — a package the registry/OSV positively flags.
Abstentions and infra errors exit `0` (a Drillable outage must not wedge your CI; `--fail-on-error`
flips that). Fail-only-on-`corrected` is near-zero-false-positive, so it's safe to leave on.

The checking is server-side ([Drillable](https://drillable.com)); this CLI is a thin client.
Source, the GitHub Action, and the pre-commit hook: https://github.com/drillablehq/drillable-check
