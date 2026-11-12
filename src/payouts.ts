// The only code path that moves money. Used by both the CLI and the web admin.
import { PayPalClient } from "./paypal.js";
import { store, type PayoutProposal } from "./store.js";

export async function describeProposal(id: string) {
  const p = await store.getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  const [submission, bounty] = await Promise.all([store.getSubmission(p.submissionId), store.getBounty(p.bountyId)]);
  return { proposal: p, submission, bounty };
}

/** Sends the PayPal payout for an approved proposal. The proposal id is PayPal's idempotency key. */
export async function approveProposal(id: string, approver: string): Promise<PayoutProposal> {
  if (!approver.trim()) throw new Error("Approver name is required");
  // Atomic claim: only one request can move a proposal from awaiting_approval to processing,
  // so double clicks or two admins approving at once can't send two payouts.
  const p = await store.claimProposal(id, approver.trim());
  if (!p) {
    const current = await store.getProposal(id);
    throw new Error(current ? `Proposal ${id} is ${current.status}` : `No proposal ${id}`);
  }
  const bounty = await store.getBounty(p.bountyId);
  try {
    const r = await new PayPalClient().createPayout({
      senderBatchId: p.id,
      receiverEmail: p.receiverEmail,
      amount: p.amount,
      currency: p.currency,
      note: `${bounty?.kind === "role" ? "Role trial" : "Bounty"} payout: ${bounty?.title ?? p.bountyId}`,
    });
    return await store.updateProposal(id, { status: "paid", paypalBatchId: r.payoutBatchId });
  } catch (e) {
    await store.updateProposal(id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export async function declineProposal(id: string, approver: string): Promise<PayoutProposal> {
  const p = await store.getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (p.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${p.status}`);
  return store.updateProposal(id, { status: "declined", decidedBy: approver, decidedAt: new Date().toISOString() });
}

export async function refreshPayoutStatus(id: string): Promise<string> {
  const p = await store.getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (!p.paypalBatchId) throw new Error("Proposal has no PayPal payout yet");
  const status = await new PayPalClient().getPayoutStatus(p.paypalBatchId);
  await store.updateProposal(id, { paypalStatus: status });
  return status;
}
