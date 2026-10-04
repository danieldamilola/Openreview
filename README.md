# OpenReview — CodeRabbit-style AI PR review bot

OpenReview reviews your pull requests automatically — on every new PR and on
every new commit pushed to it — much like CodeRabbit. It posts one updating
summary comment plus anchored inline comments, and it works with any LLM
provider: `opencode` (any model the opencode CLI supports) or any
OpenAI-compatible HTTP endpoint.

Zero npm dependencies. Runs on GitHub Actions with Node 20.

## How it works

1. The workflow `.github/workflows/pr-review.yml` triggers on
   `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`)
   and on `issue_comment` for manual `/review` re-reviews.
2. `src/index.js` resolves the diff via `scripts/incremental.js`:
   first review diffs `base...head`; later pushes diff only
   `last-reviewed-head...new-head` (falls back to the full diff after a
   rebase, skips when nothing new was pushed).
3. Deterministic rules (`rules/*.yml`, `src/rulesEngine.js`) scan added
   lines first: exact regex/glob hits (eval, secrets, focused tests, ...)
   at zero API cost. Rule hits beat LLM findings on the same line.
3. The diff is chunked (`src/diffCollector.js`), sent to the provider
   (`src/providers.js`) with a strict-JSON prompt (`src/promptBuilder.js`),
   findings are validated and filtered to changed (+) lines only, then
   formatted (`src/formatter.js`, `src/reviewEngine.js`).
4. `scripts/post-review.js` upserts ONE summary comment (found by the hidden
   `<!-- openreview-bot:summary -->` marker, so pushes never spam) and posts
   inline comments anchored to added lines only. The reviewed head SHA is
   stored in a hidden marker for the next incremental run.

## Quick start

OpenReview has two modes. The GitHub App mode reviews selected repositories
without installing a workflow in each one. See `docs/github-app-setup.md` to
deploy the webhook relay and register the app. The original GitHub Actions
workflow remains available for running the engine in this repository.

## Providers

| Provider | How | Env |
|---|---|---|
| OpenAI-compatible (default) | `POST {baseUrl}/chat/completions` | `REVIEW_PROVIDER_API_KEY`, `REVIEW_BASE_URL`, `REVIEW_MODEL` |
| opencode CLI | `opencode run --model <model>` on the runner | `REVIEW_MODEL` like `opencode/gpt-5`; install opencode in the workflow first |

Swap providers by changing the model string / vars — no code changes.
Keys always come from the environment; they are never logged.

## Manual commands and opt-out

- Comment `/review` on a PR to force a fresh full review.
- Put `/no-bot-review` in the PR body to skip automatic reviews
  (enforced when you add the `contains(...]` guard from the example, or via
  `.openreview.yml` `optOutMarker` convention in your own workflow).

## Configuration

See `.openreview.yml` for every knob: focus areas, severity threshold, ignore
patterns, diff budgets, comment mode, opt-out marker. Action inputs in
`action.yml` (or `REVIEW_*` env vars) override the file.

## Fork safety

`pull_request` events from forks get a read-only token and cannot comment.
To review fork PRs, duplicate the workflow with `pull_request_target`
(write token, base repo) but NEVER check out or execute the untrusted head
ref there — the scripts only read diffs via git/compare API, so they are
safe under `pull_request_target`.

## Repo layout

- `src/` — review engine: diff collection, prompt building, providers,
  formatting, orchestration, config. Tests: `npm test` (39 tests).
- `rules/` — deterministic pattern rules (YAML): `javascript.yml`,
  `react.yml` (React + React Native), `csharp.yml`, `rust.yml`, `dart.yml`
  (Flutter), `kotlin.yml`, `go.yml`, `java.yml`, `python.yml`,
  `security.yml` (secrets, all languages). Add your own files; broken rules are
  reported as warnings, never fail the review. Disable with
  `rules-enabled: false` / `REVIEW_RULES_ENABLED=false`.
- `scripts/` — GitHub surface: `post-review.js`, `incremental.js`, tests
  (`node --test scripts/tests/*.test.js`, 11 tests).
- `.github/workflows/pr-review.yml` — triggers, permissions, jobs.
- `action.yml` — reusable composite/node action definition.
- `.openreview.yml` — sample repo configuration.

## Local dry run

```sh
# No GitHub posting without GITHUB_TOKEN/GITHUB_REPOSITORY/PR_NUMBER:
REVIEW_DIFF="$(git diff main...HEAD)" REVIEW_MODEL=gpt-4o-mini node src/index.js
```
