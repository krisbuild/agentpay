#!/usr/bin/env node
// Commands:
//   agent "<task>"                     run the Claude agent (e.g. "review all pending submissions")
//   submit <bountyId> <name> <email> <content>   record a hunter's submission
//   proposals                           list payout proposals awaiting approval
//   approve <proposalId> <yourName>     HUMAN step: send the PayPal payout
//   decline <proposalId> <yourName>     HUMAN step: decline the proposal
//   status <proposalId>                 refresh payout status from PayPal
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { PayPalClient } from "./paypal.js";
import { store } from "./store.js";

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} Type "yes" to continue: `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "agent": {
      if (!args.length) throw new Error('Usage: agent "<task>"');
      console.log(await runAgent(args.join(" ")));
      break;
    }
    case "submit": {
      const [bountyId, hunterName, hunterPaypalEmail, ...content] = args;
      if (!content.length) throw new Error("Usage: submit <bountyId> <name> <paypalEmail> <content...>");
      console.log(store.createSubmission({ bountyId, hunterName, hunterPaypalEmail, content: content.join(" ") }));
      break;
    }
    case "proposals": {
      console.table(
        store.listProposals("awaiting_approval").map(({ id, bountyId, receiverEmail, amount, currency }) => ({
          id, bountyId, receiverEmail, amount, currency,
        })),
      );
      break;
    }
    case "approve": {
      const [id, approver] = args;
      if (!id || !approver) throw new Error("Usage: approve <proposalId> <yourName>");
      const p = store.getProposal(id);
      if (!p) throw new Error(`No proposal ${id}`);
      if (p.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${p.status}`);
      const sub = store.getSubmission(p.submissionId);
      const paypal = new PayPalClient();
      console.log(`\nBounty:      ${store.getBounty(p.bountyId)?.title}`);
      console.log(`Recipient:   ${p.receiverEmail} (${sub?.hunterName})`);
      console.log(`Amount:      ${p.amount} ${p.currency}`);
      console.log(`PayPal env:  ${paypal.env.toUpperCase()}`);
      console.log(`Review:      ${sub?.review?.reasoning}\n`);
      if (!(await confirm("Send this payout?"))) return console.log("Cancelled.");
      try {
        const r = await paypal.createPayout({
          senderBatchId: p.id,
          receiverEmail: p.receiverEmail,
          amount: p.amount,
          currency: p.currency,
          note: `Bounty payout: ${store.getBounty(p.bountyId)?.title}`,
        });
        store.updateProposal(id, {
          status: "paid", paypalBatchId: r.payoutBatchId, decidedBy: approver, decidedAt: new Date().toISOString(),
        });
        console.log(`Payout sent. PayPal batch ${r.payoutBatchId} (${r.batchStatus}).`);
      } catch (e) {
        store.updateProposal(id, { status: "failed", error: String(e), decidedBy: approver });
        throw e;
      }
      break;
    }
    case "decline": {
      const [id, approver] = args;
      if (!id || !approver) throw new Error("Usage: decline <proposalId> <yourName>");
      console.log(store.updateProposal(id, { status: "declined", decidedBy: approver, decidedAt: new Date().toISOString() }));
      break;
    }
    case "status": {
      const p = store.getProposal(args[0]);
      if (!p?.paypalBatchId) throw new Error("Proposal not found or not paid");
      console.log(await new PayPalClient().getPayoutStatus(p.paypalBatchId));
      break;
    }
    default:
      console.log("Commands: agent, submit, proposals, approve, decline, status (see README.md)");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
