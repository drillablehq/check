# Drillable Check

**Catch the dependencies that don't exist.** `drillable-check` reads the lockfiles you already commit
and grades every package against the **live** registry + advisory database — so a hallucinated name, a
slop/typo-squat, an unpublished version, or a known CVE fails the build *before* it ships. It is not a
model guessing; each verdict drills to the registry or OSV URL that decided it.

It's the half `npm audit` doesn't do: audit catches *known-vulnerable* packages — it can't catch a
package that **doesn't exist** (the name an AI assistant confidently invented, which an attacker then
registers). Check catches both.

```
npx drillable-check package.json            # check a manifest
npx drillable-check --diff                   # only what changed vs the base ref (the CI default)
npx drillable-check --json                   # machine output
```

It is **not a plugin** — it's a service you call. The checking happens server-side (the
[Drillable](https://drillable.com) corpus); the CLI is a thin client, so improvements ship without you
updating anything.

## What it checks today

You give it files; it parses the **declared dependencies** (no model, no guessing — a lockfile is
ground truth) and resolves each one live:

| Ecosystem | Files | What's graded |
| --- | --- | --- |
| npm | `package.json`, `package-lock.json` | name exists · version published · known CVEs (OSV) |
| PyPI | `requirements.txt` | name exists · pinned (`==`) version published · known CVEs |

Each dependency comes back **`verified`** (real, drilled to the registry), **`corrected`** (a denied
name / unpublished version / known CVE — *the gate*), or **`abstained`** (an ecosystem it doesn't cover
yet, or the registry was unreachable — never a false denial).

## The gate semantics are the whole game

`drillable-check` exits:

- **`0`** — nothing `corrected`.
- **`1`** — at least one **`corrected`**: a package the registry/OSV *positively* flags (absent name,
  unpublished version, or a known advisory).
- **Abstentions never fail the build.** An uncovered ecosystem or an unreachable registry is not a
  defect. Infra/auth errors also exit `0` by default (a Drillable outage must not wedge your CI; pass
  `--fail-on-error` to flip that).

Fail-only-on-`corrected` gives **near-zero-false-positive gating** — it can only block on something the
oracle can *prove* (the package literally isn't there). That is what makes it safe to leave on: noisy
gates get deleted; this one is quiet by construction.

## Why this is separate from Use Drillable

[Use Drillable](https://github.com/drillablehq/use-drillable) is a Claude Code *plugin* — one editor,
one agent. **Check is a service**, and most of its surfaces aren't agents at all:

| Surface | Form | Status |
| --- | --- | --- |
| CLI | `npx drillable-check <path>` | **live** (`cli/`) |
| CI gate | a GitHub Action / pre-commit hook on every PR | **live** (`action.yml`, `.pre-commit-hooks.yaml`) |
| IDE | VS Code / JetBrains extension | planned |
| Claude Code | a Stop-hook "rail" + `/check` command (`claude-code/`) | parked seed |

The CLI / CI gate is the coder-adoption wedge — it meets developers in the tools they already use, no
agent required, which is bigger reach than any one plugin.

## Drop it into CI

```yaml
# .github/workflows/drillable-check.yml — fails a PR that adds a hallucinated/squatted/vulnerable dep
- uses: drillablehq/drillable-check@v0
  with:
    api-key: ${{ secrets.DRILLABLE_KEY }}   # optional today; reserved for per-key limits
```

Or as a pre-commit hook:

```yaml
- repo: https://github.com/drillablehq/drillable-check
  rev: v0.1.0
  hooks:
    - id: drillable-check
```

See `examples/github-workflow.yml`.

## Roadmap — claims beyond dependencies

The engine is general: the same `verified` / `corrected` / `abstained` receipt can grade *any* checkable
claim against a cited source (the [Drillable](https://drillable.com) fleet covers ~60 reference domains).
The next lane extracts factual claims from prose and grades them the same way — the dependency check is
the first, sharpest instance because a lockfile needs no extraction. Until that lands, the CLI checks
dependencies and stays silent (never a false `corrected`) on everything else.

## Layout

```
cli/                   the thin client (the npm package: `drillable-check`)
action.yml             GitHub Action — wraps the CLI
.pre-commit-hooks.yaml pre-commit integration — wraps the CLI
examples/              copy-paste consumer workflow
claude-code/           the Claude Code adapter (Stop hook + /check), parked
docs/                  engine design notes
```
