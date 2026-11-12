#!/usr/bin/env node
// Commands:
//   agent "<task>"                     run the AI agent (e.g. "review all pending submissions")
//   submit <bountyId> <name> <email> <content>   record a hunter's submission
//   proposals                           list payout proposals awaiting approval
//   approve <proposalId> <yourName>     HUMAN step: send the PayPal payout
//   decline <proposalId> <yourName>     HUMAN step: decline the proposal
//   status <proposalId>                 refresh payout status from PayPal
import { createInterface } from "node:readline/promises";
import { runAgent } from "./agent.js";
import { approveProposal, declineProposal, describeProposal, refreshPayoutStatus } from "./payouts.js";
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
      console.log(await store.createSubmission({ bountyId, hunterName, hunterPaypalEmail, content: content.join(" ") }));
      break;
    }
    case "proposals": {
      console.table(
        (await store.listProposals("awaiting_approval")).map(({ id, bountyId, receiverEmail, amount, currency }) => ({
          id, bountyId, receiverEmail, amount, currency,
        })),
      );
      break;
    }
    case "approve": {
      const [id, approver] = args;
      if (!id || !approver) throw new Error("Usage: approve <proposalId> <yourName>");
      const { proposal: p, submission, bounty } = await describeProposal(id);
      if (p.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${p.status}`);
      console.log(`\nBounty:      ${bounty?.title}`);
      console.log(`Recipient:   ${p.receiverEmail} (${submission?.hunterName})`);
      console.log(`Amount:      ${p.amount} ${p.currency}`);
      console.log(`PayPal env:  ${(process.env.PAYPAL_ENV ?? "sandbox").toUpperCase()}`);
      console.log(`Review:      ${submission?.review?.reasoning}\n`);
      if (!(await confirm("Send this payout?"))) return console.log("Cancelled.");
      const paid = await approveProposal(id, approver);
      console.log(`Payout sent. PayPal batch ${paid.paypalBatchId}.`);
      break;
    }
    case "decline": {
      const [id, approver] = args;
      if (!id || !approver) throw new Error("Usage: decline <proposalId> <yourName>");
      console.log(await declineProposal(id, approver));
      break;
    }
    case "status": {
      if (!args[0]) throw new Error("Usage: status <proposalId>");
      console.log(await refreshPayoutStatus(args[0]));
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
