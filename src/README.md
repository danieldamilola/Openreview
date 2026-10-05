# OpenReview — core PR review engine

Language choice: **Node.js (plain JavaScript, CommonJS)** — runs on the
GitHub Actions `node20` runtime with **zero npm dependencies** (no build
step, no `npm install`). This satisfies the brief's "TypeScript Node or
Python" by choosing the Node path in dependency-free JavaScript, keeping
every exported function unit-testable with the stdlib runner
(`npm test` → `node --test src/`).

CodeRabbit-style behavior: review on `pull_request` **opened** plus
**synchronize**; **incremental** review of only new commits where feasible
(pass the last-reviewed head SHA as `base`); file- and hunk-level analysis;
severity labels (`critical|major|minor`, style nits are never reported); summary plus inline findings;
ignore patterns.

## Layout

- `src/diffCollector.js` — `parseUnifiedDiff`, `chunkFiles`,
  `buildChangedLineIndex`, `collectDiff({base, head})` with three-dot →
  two-dot fallback, size limits + truncation, ignore globs, empty-diff
  handling.
- `src/promptBuilder.js` — `buildReviewPrompt` (strict-JSON schema
  `{file,line,severity,message,suggestion?}`), `validateFindings`,
  `filterFindingsToDiff` (anchors findings to added `+` lines only).
- `src/providers.js` — `createProvider({provider, model})`,
  `OpencodeProvider` (`opencode run --model <model>` via model string,
  key from env), `OpenAICompatibleProvider` (`POST {baseUrl}/chat/
  completions`, key from env). Swappable via model string + env key.
- `src/formatter.js` — `formatSummary` (GitHub markdown),
  `formatInlineComments` / `formatReviewPayload` (inline payloads).
- `src/reviewEngine.js` — `runReview` orchestration (chunk → prompt →
  provider → validate → anchor-filter → format; empty/oversized safe).
- `src/config.js` — inputs/env loading, model selectable via input or
  config, limits, ignore patterns.
- `src/index.js` — action entrypoint (`action.yml` → `src/index.js`).
- `src/*.test.js` — unit tests (diff chunking, prompt building,
  formatting, provider swapping).

## Example workflow

```yaml
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: danieldamilola/Openreview@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          provider: openai-compatible
          model: gpt-4o-mini
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          ignore-patterns: '**/*.lock,dist/'
        env:
          REVIEW_PROVIDER_API_KEY: ${{ secrets.REVIEW_PROVIDER_API_KEY }}
```
