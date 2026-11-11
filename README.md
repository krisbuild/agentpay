# agentpay

An AI agent (Claude) that runs a bounty program and pays hunters through the **PayPal Payouts API**.

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

- `ANTHROPIC_API_KEY`: from the Claude Console
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: a REST app at developer.paypal.com with **Payouts** enabled (use sandbox credentials first)

## Usage

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

- `src/agent.ts`: Claude tool-runner agent (Opus 5.5, adaptive thinking, refusal fallbacks)
- `src/paypal.ts`: PayPal OAuth and Payouts client
- `src/store.ts`: JSON-file store (`data/db.json`); replace it with a database for production
- `src/cli.ts`: commands, including the human approval step

## Next steps

- Add an HTTP endpoint or GitHub webhook so hunters can submit directly
- Add PayPal webhooks (`PAYMENT.PAYOUTS-ITEM.*`) to track final payout status
- Move storage to Postgres/SQLite
