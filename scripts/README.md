# AI PR Review — automation scripts

Dependency-light Node helpers used by the `pr-review` workflow. All modules
use the global `fetch` (Node 18+) and Node built-ins only.

- `scripts/post-review.js` — find-or-create the single summary comment and post
  inline comments anchored to diff lines.
- `scripts/incremental.js` — recover the previously reviewed SHA and choose the
  diff range so pushes review only new commits.

The workflow runs `node src/index.js` (the core engine, supplied separately).
The engine computes the diff, calls the provider, then calls these modules.

## Engine interface (`src/index.js`)

Environment provided by the workflow:

| Variable | Meaning |
| --- | --- |
| `GITHUB_TOKEN` | `secrets.GH_TOKEN` or the automatic token (never logged). |
| `GITHUB_API_URL` | API base, e.g. `https://api.github.com`. |
| `GITHUB_REPOSITORY` | `owner/repo`. |
| `PR_NUMBER` | Pull request number. |
| `BASE_SHA`, `HEAD_SHA` | Present for `pull_request`; empty for `issue_comment`. |
| `REVIEW_FORCE` | `true` for the `/review` command job. |
| `REVIEW_PROVIDER` | `heuristic` (default) or an AI provider id. |
| `REVIEW_MODEL`, `REVIEW_BASE_URL` | Provider model / endpoint overrides. |
| `REVIEW_PROVIDER_API_KEY` | Provider key (optional for heuristic). |
| `REVIEW_INLINE` | `true`/`false`, post inline comments. |
| `REVIEW_STATE_FILE` | Optional artifact path holding `{ "reviewedSha": "..." }`. |

Suggested flow inside the engine:

1. `const { planDiff, resolveDiff } = require('./scripts/incremental');`
2. Resolve base/head from the pulls API when `BASE_SHA`/`HEAD_SHA` are empty.
3. `resolveDiff(...)` returns `{ base, head, mode, source, diff }`; skip when
   `mode === 'up-to-date'`.
4. Call the provider, producing `{ verdict, summary, comments: [{ path, line, body, severity }] }`.
5. Post progress, then the final verdict:
   ```js
   const { upsertSummaryComment, postInlineComments, reviewedStateMarker } =
     require('./scripts/post-review');
   await upsertSummaryComment({ token, repo, prNumber, body: 'Starting review…' });
   // ... call provider ...
   await upsertSummaryComment({ token, repo, prNumber,
     body: `${summary}\n\n${reviewedStateMarker(headSha)}` });
   await postInlineComments({ token, repo, prNumber, commitId: headSha, comments, diff });
   ```

## Comment markers

- Summary comment marker (hidden): `<!-- openreview-bot:summary -->`. Only one
  comment ever carries it; it is patched in place on every run.
- Reviewed SHA marker (hidden): `<!-- openreview-bot:reviewed:<sha> -->` written
  into the summary comment so `incremental.js` can compute the next range.

## Inline comment safety

`postInlineComments` parses the unified diff and only submits comments whose
`path`/`line` correspond to an **added** (right-side) line. Comments on context
or removed lines are dropped, so the pulls API never rejects the review.

## Required secrets

- `GH_TOKEN` (optional): a PAT or GitHub App token. Falls back to the automatic
  `GITHUB_TOKEN`. Use a PAT only when you need to trigger other workflows or
  comment on fork PRs.
- `REVIEW_PROVIDER_API_KEY`: key for the AI provider. Optional when
  `REVIEW_PROVIDER=heuristic`; required otherwise.

Secrets are read from the environment and are never written to disk; the
workflow passes them via `env:` only. `config` output must never echo them.

## Fork safety

`pull_request` from a fork receives a read-only `GITHUB_TOKEN` and cannot post
comments. To review fork PRs, switch the trigger to `pull_request_target`, which
runs in the base repo with a write token. In that mode **never check out or run
the untrusted head ref** (`github.event.pull_request.head.sha`). These scripts
only read diffs (compare API fallback) and call the API, so they are safe there.
Do not combine `pull_request_target` with a custom checkout of the PR head
followed by executing PR code.

## Local checks

```bash
node --check scripts/post-review.js
node --check scripts/incremental.js
node --test scripts/tests
```
