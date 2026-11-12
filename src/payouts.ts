// The only code path that moves money. Used by both the CLI and the web admin.
import { PayPalClient } from "./paypal.js";
import { store, type PayoutProposal } from "./store.js";

export function describeProposal(id: string) {
  const p = store.getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  const submission = store.getSubmission(p.submissionId);
  const bounty = store.getBounty(p.bountyId);
  return { proposal: p, submission, bounty };
}

/** Sends the PayPal payout for an approved proposal. The proposal id is the idempotency key. */
export async function approveProposal(id: string, approver: string): Promise<PayoutProposal> {
  const { proposal: p, bounty } = describeProposal(id);
  if (p.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${p.status}`);
  if (!approver.trim()) throw new Error("Approver name is required");

  // Mark as in-flight first so a double click can't start a second payout.
  store.updateProposal(id, { status: "processing", decidedBy: approver, decidedAt: new Date().toISOString() });
  try {
    const r = await new PayPalClient().createPayout({
      senderBatchId: p.id,
      receiverEmail: p.receiverEmail,
      amount: p.amount,
      currency: p.currency,
      note: `Bounty payout: ${bounty?.title ?? p.bountyId}`,
    });
    return store.updateProposal(id, { status: "paid", paypalBatchId: r.payoutBatchId });
  } catch (e) {
    store.updateProposal(id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export function declineProposal(id: string, approver: string): PayoutProposal {
  const { proposal: p } = describeProposal(id);
  if (p.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${p.status}`);
  return store.updateProposal(id, { status: "declined", decidedBy: approver, decidedAt: new Date().toISOString() });
}

export async function refreshPayoutStatus(id: string): Promise<string> {
  const { proposal: p } = describeProposal(id);
  if (!p.paypalBatchId) throw new Error("Proposal has no PayPal payout yet");
  const status = await new PayPalClient().getPayoutStatus(p.paypalBatchId);
  store.updateProposal(id, { paypalStatus: status });
  return status;
}
