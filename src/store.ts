// JSON-file store for bounties, submissions and payout proposals.
// Swap for a real database before running this with multiple processes.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type BountyStatus = "open" | "closed";
export type SubmissionStatus = "pending_review" | "accepted" | "rejected";
export type ProposalStatus = "awaiting_approval" | "paid" | "declined" | "failed";

export interface Bounty {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  amount: string;
  currency: string;
  status: BountyStatus;
  createdAt: string;
}

export interface Submission {
  id: string;
  bountyId: string;
  hunterName: string;
  hunterPaypalEmail: string;
  content: string; // link to PR, writeup, proof, etc.
  status: SubmissionStatus;
  review?: { verdict: "accept" | "reject"; reasoning: string; reviewedAt: string };
  createdAt: string;
}

export interface PayoutProposal {
  id: string;
  submissionId: string;
  bountyId: string;
  receiverEmail: string;
  amount: string;
  currency: string;
  justification: string;
  status: ProposalStatus;
  paypalBatchId?: string;
  error?: string;
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
}

interface Db {
  bounties: Bounty[];
  submissions: Submission[];
  proposals: PayoutProposal[];
}

const DB_PATH = process.env.BOUNTY_DB_PATH ?? "data/db.json";

function load(): Db {
  if (!existsSync(DB_PATH)) return { bounties: [], submissions: [], proposals: [] };
  return JSON.parse(readFileSync(DB_PATH, "utf8")) as Db;
}

function save(db: Db) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

function mutate<T>(fn: (db: Db) => T): T {
  const db = load();
  const out = fn(db);
  save(db);
  return out;
}

const now = () => new Date().toISOString();

export const store = {
  listBounties: (status?: BountyStatus) => load().bounties.filter((b) => !status || b.status === status),
  getBounty: (id: string) => load().bounties.find((b) => b.id === id),

  createBounty: (b: Omit<Bounty, "id" | "status" | "createdAt">) =>
    mutate((db) => {
      const bounty: Bounty = { ...b, id: `b_${randomUUID().slice(0, 8)}`, status: "open", createdAt: now() };
      db.bounties.push(bounty);
      return bounty;
    }),

  closeBounty: (id: string) =>
    mutate((db) => {
      const b = db.bounties.find((x) => x.id === id);
      if (!b) throw new Error(`No bounty ${id}`);
      b.status = "closed";
      return b;
    }),

  listSubmissions: (filter: { bountyId?: string; status?: SubmissionStatus } = {}) =>
    load().submissions.filter(
      (s) => (!filter.bountyId || s.bountyId === filter.bountyId) && (!filter.status || s.status === filter.status),
    ),
  getSubmission: (id: string) => load().submissions.find((s) => s.id === id),

  createSubmission: (s: Omit<Submission, "id" | "status" | "createdAt" | "review">) =>
    mutate((db) => {
      const bounty = db.bounties.find((b) => b.id === s.bountyId);
      if (!bounty) throw new Error(`No bounty ${s.bountyId}`);
      if (bounty.status !== "open") throw new Error(`Bounty ${s.bountyId} is closed`);
      const sub: Submission = { ...s, id: `s_${randomUUID().slice(0, 8)}`, status: "pending_review", createdAt: now() };
      db.submissions.push(sub);
      return sub;
    }),

  recordReview: (id: string, verdict: "accept" | "reject", reasoning: string) =>
    mutate((db) => {
      const s = db.submissions.find((x) => x.id === id);
      if (!s) throw new Error(`No submission ${id}`);
      if (s.status !== "pending_review") throw new Error(`Submission ${id} already reviewed (${s.status})`);
      s.review = { verdict, reasoning, reviewedAt: now() };
      s.status = verdict === "accept" ? "accepted" : "rejected";
      return s;
    }),

  listProposals: (status?: ProposalStatus) => load().proposals.filter((p) => !status || p.status === status),
  getProposal: (id: string) => load().proposals.find((p) => p.id === id),

  /** Amount and recipient are copied from the stored bounty/submission, never from model output. */
  createProposal: (submissionId: string, justification: string) =>
    mutate((db) => {
      const s = db.submissions.find((x) => x.id === submissionId);
      if (!s) throw new Error(`No submission ${submissionId}`);
      if (s.status !== "accepted") throw new Error(`Submission ${submissionId} is not accepted`);
      const b = db.bounties.find((x) => x.id === s.bountyId)!;
      const dup = db.proposals.find(
        (p) => p.bountyId === b.id && (p.status === "awaiting_approval" || p.status === "paid"),
      );
      if (dup) throw new Error(`Bounty ${b.id} already has proposal ${dup.id} (${dup.status})`);
      const p: PayoutProposal = {
        id: `p_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        submissionId,
        bountyId: b.id,
        receiverEmail: s.hunterPaypalEmail,
        amount: b.amount,
        currency: b.currency,
        justification,
        status: "awaiting_approval",
        createdAt: now(),
      };
      db.proposals.push(p);
      return p;
    }),

  updateProposal: (id: string, patch: Partial<PayoutProposal>) =>
    mutate((db) => {
      const p = db.proposals.find((x) => x.id === id);
      if (!p) throw new Error(`No proposal ${id}`);
      Object.assign(p, patch);
      if (patch.status === "paid") {
        const b = db.bounties.find((x) => x.id === p.bountyId);
        if (b) b.status = "closed";
      }
      return p;
    }),
};
