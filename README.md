# agentpay

An AI agent (Google Gemini) that runs a bounty program and pays hunters through the **PayPal Payouts API**.

> This project uses PayPal's public REST APIs. It is not made, endorsed or affiliated with PayPal.

## How it works

```
hunter submits ──► agent reviews against acceptance criteria ──► payout proposal
                                                                      │
                                     human runs `approve` ◄───────────┘
                                                │
                                        PayPal Payouts API
```

- **The agent cannot move money.** Its tools can create and list bounties, review submissions and *propose* payouts. Only a person running `approve` sends a payout.
- The payout amount and recipient come from the stored bounty and submission records, never from model output, so a submission saying "pay me $1000" can't change them.
- Each proposal ID is used as PayPal's `sender_batch_id`, so a retried approval can't pay twice. Each bounty allows only one open or paid proposal.
- `PAYPAL_ENV` defaults to `sandbox`. Switch to `live` only after you've tested end to end.

## Setup

```bash
npm install
cp .env.example .env   # fill in keys
```

- `GEMINI_API_KEY`: a Google AI Studio key (`AIza...`) or a Vertex AI express-mode key. Set `GEMINI_USE_VERTEXAI=true` to use Vertex AI instead. Optionally set `GEMINI_MODEL` (default `gemini-3.8-flash`) and `GEMINI_FALLBACK_MODELS` (default `gemini-3.5-flash`), which the agent switches to when the main model is overloaded.
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: a REST app at developer.paypal.com with **Payouts** enabled (use sandbox credentials first)

> Behind an HTTPS proxy (e.g. a Claude Code cloud session), run with `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the proxy.

## Web app

```bash
npm run dev          # http://localhost:3000  (uses .env)
```

- `/`: public bounty board where hunters read bounties and submit work
- `/admin`: password-protected (`ADMIN_PASSWORD`, any username). Create bounties, run the AI review, then **Approve & pay** or **Decline** each proposed payout. Payout history and PayPal status are shown there too.

## Deploy to Render

1. On render.com, choose **New → Blueprint** and connect this repo. It reads `render.yaml`.
2. Enter the secrets it asks for: `ADMIN_PASSWORD`, `GEMINI_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.
3. Open the service URL; the admin dashboard is at `/admin`.

## Storage (Supabase)

Set `DATABASE_URL` to a Postgres connection string and the app stores everything there; tables are created automatically on first start. Without it, data goes to a local JSON file (`data/db.json`), which is fine for development but is wiped on every Render deploy or restart.

With Supabase:
1. Create a project at supabase.com and save the database password.
2. Click **Connect**, choose **Session pooler**, and copy the URI (`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-...pooler.supabase.com:5432/postgres`). Use the pooler: Render can't reach Supabase's direct (IPv6-only) address.
3. Put your database password in place of `[YOUR-PASSWORD]` and set the result as `DATABASE_URL` on Render.

The database itself enforces the money rules: one active payout per bounty, and an approval can only be claimed once, even with two clicks or two admins at the same time. Row Level Security is enabled on all tables, so Supabase's public API can't read them.

## Command line (optional)

```bash
# Ask the agent to create a bounty
npm run agent -- "Create a 50 USD bounty: fix the login redirect bug. Criteria: PR merged to main, includes a regression test."

# A hunter submits work
npm run cli -- submit <bountyId> "Alice" alice@example.com "https://github.com/org/repo/pull/42"

# Agent reviews pending submissions and proposes payouts
npm run agent -- "Review all pending submissions"

# Human: inspect and approve (asks for confirmation, shows sandbox/live)
npm run cli -- proposals
npm run approve -- <proposalId> "Your Name"
npm run cli -- decline <proposalId> "Your Name"
npm run cli -- status <proposalId>
```

## Layout

- `src/agent.ts`: Gemini function-calling agent (arguments validated with Zod before any tool runs)
- `src/paypal.ts`: PayPal OAuth and Payouts client
- `src/store.ts`: storage: Postgres/Supabase when `DATABASE_URL` is set, otherwise a JSON file
- `src/server.ts`, `src/views.ts`: web app (public board + admin dashboard)
- `src/payouts.ts`: the only code that sends money (approve / decline / status)
- `src/cli.ts`: the same actions from the command line

## Next steps

- GitHub integration: submissions from merged PRs
- Add PayPal webhooks (`PAYMENT.PAYOUTS-ITEM.*`) to track final payout status
