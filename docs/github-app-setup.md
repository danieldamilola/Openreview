# Set up the OpenReview GitHub App

The app receives pull request events through a Cloudflare Worker, then starts
the review workflow in this repository. Install the app on OpenReview and on
each repository you want it to review. Target repositories do not need their
own workflow, API key, or Actions variables.

## 1. Deploy the webhook relay

Create a Cloudflare account, install Node.js, then run these commands from the
OpenReview checkout:

```sh
npx wrangler@4 login
npx wrangler@4 deploy
```

Cloudflare prints the Worker URL after deployment. With the current name, it
will be `https://openreview0.openreview0.workers.dev`; the GitHub webhook URL
will be that URL followed by `/webhook`.

## 2. Register the GitHub App

In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub
App**. Set the name to `OpenReview`, add the project URL, and upload
`assets/openreview0-app-icon.png` as its logo.
Use the Worker URL plus `/webhook` for the webhook URL. Choose a strong random
webhook secret and keep it for the next step.

Request these repository permissions:

- **Contents: Read.** The reviewer fetches pull request diffs.
- **Pull requests: Read and write.** The reviewer reads diffs and posts inline
  review comments.
- **Issues: Read and write.** Pull request summary comments use the issues API.

Subscribe to the `Pull request` and `Issue comment` events. Set installation
visibility to **Only on this account** unless you plan to let other GitHub
accounts install OpenReview. Create the app, but do not install it until the
secrets below are configured.

## 3. Create a dispatch token and add the app secrets

The Worker needs a narrowly scoped token to start the central workflow. In
GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-
grained tokens → Generate new token**. Choose `danieldamilola` as the resource
owner, select only the `Openreview` repository, and grant **Contents: Read and
write**. Copy the token into a Cloudflare Worker secret named
`DISPATCH_TOKEN`.

Download a private key from the GitHub App settings. In the OpenReview
repository, open **Settings → Secrets and variables → Actions** and add:

- Secret `OPENREVIEW_APP_ID`: the numeric App ID shown in the app settings.
- Secret `OPENREVIEW_APP_PRIVATE_KEY`: the downloaded private key contents.
- Secret `REVIEW_PROVIDER_API_KEY`: your Gemini API key.

Add these repository variables:

- `REVIEW_PROVIDER` = `openai-compatible`
- `REVIEW_BASE_URL` = `https://generativelanguage.googleapis.com/v1beta/openai/`
- `REVIEW_MODEL` = `gemini-3.5-flash-lite`

Set the dispatch token and webhook secret in the Worker:

```sh
npx wrangler@4 secret put DISPATCH_TOKEN
npx wrangler@4 secret put WEBHOOK_SECRET
```

Each command prompts for its value. Keep these secrets and the app private key
out of chat and source files.

## 4. Install the app

In the GitHub App settings, choose **Install App**. Select OpenReview and the
repositories you want it to review, or choose all repositories. Pull requests
and new commits will trigger reviews. Comment `/review` on a PR to request a
fresh review.

The relay runs on Cloudflare Workers. The Free plan currently includes up to
100,000 requests per day; Gemini API usage has its own quota and pricing.
Check [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) for
current limits.
