// Storage for bounties, submissions and payout proposals.
//
// - DATABASE_URL set   -> Postgres (e.g. Supabase). Tables are created on first use.
// - DATABASE_URL unset -> a local JSON file (BOUNTY_DB_PATH, default data/db.json), for development.
//
// Both backends enforce the same money-safety rules:
// - at most one active (awaiting/processing/paid) payout proposal per submission
// - proposal amounts are computed from stored scores, never from model output
// - a proposal can only be claimed for payment once (claimProposal is atomic)
import { randomUUID } from "node:crypto";
import { demoBounty, demoProposal, demoSubmission } from "./demo-board.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

export type BountyStatus = "open" | "closed";
export type ListingKind = "bounty" | "role";
export type SubmissionStatus = "pending_review" | "accepted" | "rejected";
export type ProposalStatus = "awaiting_approval" | "processing" | "paid" | "declined" | "failed";

/** Remote roles a short paid trial can prove. Other work is a bounty, not a role. */
export const ROLE_CATEGORIES = ["writing", "design", "engineering", "research", "video", "support", "translation"] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];
export const ROLE_CATEGORY_LABELS: Record<RoleCategory, string> = {
  writing: "Writing and editing",
  design: "Design",
  engineering: "Engineering",
  research: "Research",
  video: "Video and social",
  support: "Support and operations",
  translation: "Translation",
};

export interface Bounty {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Reward pool. For a role this pays the trial, not the hire. */
  amount: string;
  currency: string;
  status: BountyStatus;
  createdAt: string;
  kind: ListingKind;
  /** Set only for roles. */
  category?: RoleCategory;
  /** The short sample applicants submit. Display and review only. */
  trialTask?: string;
  /** Stated pay for the hire. Display only; PayPal never sends this. */
  rolePay?: string;
}

export interface Submission {
  id: string;
  bountyId: string;
  hunterName: string;
  hunterPaypalEmail: string;
  content: string; // link to PR, writeup, proof, etc.
  status: SubmissionStatus;
  review?: { verdict: "accept" | "reject"; reasoning: string; score: number; reviewedAt: string };
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
  paypalStatus?: string;
  error?: string;
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
}

export type NewBounty = Omit<Bounty, "id" | "status" | "createdAt" | "kind" | "category" | "trialTask" | "rolePay"> & {
  kind?: ListingKind;
  category?: RoleCategory;
  trialTask?: string;
  rolePay?: string;
};
export type NewSubmission = Omit<Submission, "id" | "status" | "createdAt" | "review">;
type ProposalPatch = Partial<Pick<PayoutProposal, "status" | "paypalBatchId" | "paypalStatus" | "error" | "decidedBy" | "decidedAt">>;

export interface Store {
  /** Connectivity check for /healthz. Never includes credentials. */
  ping(): Promise<{ ok: true } | { ok: false; code: string; hint: string }>;
  listBounties(status?: BountyStatus, kind?: ListingKind): Promise<Bounty[]>;
  getBounty(id: string): Promise<Bounty | undefined>;
  createBounty(b: NewBounty): Promise<Bounty>;
  closeBounty(id: string): Promise<Bounty>;
  listSubmissions(filter?: { bountyId?: string; status?: SubmissionStatus }): Promise<Submission[]>;
  getSubmission(id: string): Promise<Submission | undefined>;
  createSubmission(s: NewSubmission): Promise<Submission>;
  recordReview(id: string, verdict: "accept" | "reject", reasoning: string, score: number): Promise<Submission>;
  listProposals(status?: ProposalStatus): Promise<PayoutProposal[]>;
  getProposal(id: string): Promise<PayoutProposal | undefined>;
  /**
   * Split a bounty's reward pool across accepted submissions in proportion to their
   * stored scores. Amounts are calculated here. Scores under 20 get nothing.
   */
  splitPool(bountyId: string): Promise<PayoutProposal[]>;
  /** Change a proposed amount before approval. The new total cannot exceed the reward pool. */
  setProposalAmount(id: string, amount: string): Promise<PayoutProposal>;
  /** Atomically moves awaiting_approval -> processing. Returns undefined if it was not awaiting approval. */
  claimProposal(id: string, approver: string): Promise<PayoutProposal | undefined>;
  updateProposal(id: string, patch: ProposalPatch): Promise<PayoutProposal>;
  /** Insert the filmed board when its ids are not already stored. Does not send money. */
  ensureDemoBoard(): Promise<void>;
}

const now = () => new Date().toISOString();
const newId = (prefix: string, len = 8) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, len)}`;
const ACTIVE: ProposalStatus[] = ["awaiting_approval", "processing", "paid"];
/** Scores below this get no share of the pool. */
const MIN_PAYOUT_SCORE = 20;

const toCents = (amount: string) => {
  const [whole, frac = ""] = amount.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
};
const fromCents = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** Largest-remainder split so the shares add up to the pool exactly. */
function poolShares(poolCents: number, scores: number[]): number[] {
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (total <= 0 || poolCents <= 0) return scores.map(() => 0);
  const floors = scores.map((score) => Math.floor((poolCents * score) / total));
  let left = poolCents - floors.reduce((sum, share) => sum + share, 0);
  const order = scores
    .map((score, index) => ({ index, frac: (poolCents * score) / total - floors[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const item of order) {
    if (left <= 0) break;
    floors[item.index] += 1;
    left -= 1;
  }
  return floors;
}

function checkScore(score: number) {
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error("Score must be a whole number from 0 to 100");
}

function isRoleCategory(value: string | undefined): value is RoleCategory {
  return !!value && (ROLE_CATEGORIES as readonly string[]).includes(value);
}

/** Bounties stay bounties. A role must be one of the trial categories and must name the trial. */
function settleListing(b: NewBounty): Omit<Bounty, "id" | "status" | "createdAt"> {
  const amount = /^\d+$/.test(b.amount) ? `${b.amount}.00` : b.amount;
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("Amount must look like 50.00");
  const base = {
    title: b.title.trim(),
    description: b.description.trim(),
    acceptanceCriteria: b.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
    amount,
    currency: b.currency.trim().toUpperCase(),
  };
  if (!base.acceptanceCriteria.length) throw new Error("Add at least one acceptance criterion.");
  if ((b.kind ?? "bounty") === "bounty") return { ...base, kind: "bounty" };
  if (!isRoleCategory(b.category)) {
    throw new Error("A role must be writing, design, engineering, research, video, support, or translation.");
  }
  const trialTask = b.trialTask?.trim() ?? "";
  if (trialTask.length < 10) throw new Error("Describe the paid trial (at least 10 characters).");
  const rolePay = b.rolePay?.trim();
  return { ...base, kind: "role", category: b.category, trialTask, ...(rolePay ? { rolePay } : {}) };
}

// ---------------------------------------------------------------- JSON file

interface Db {
  bounties: Bounty[];
  submissions: Submission[];
  proposals: PayoutProposal[];
}

class JsonStore implements Store {
  constructor(private path: string) {}

  async ping() {
    return { ok: true as const };
  }

  private load(): Db {
    if (!existsSync(this.path)) return { bounties: [], submissions: [], proposals: [] };
    const db = JSON.parse(readFileSync(this.path, "utf8")) as Db;
    for (const bounty of db.bounties) {
      if (bounty.kind !== "role") bounty.kind = "bounty";
      if (!isRoleCategory(bounty.category)) delete bounty.category;
    }
    return db;
  }
  private mutate<T>(fn: (db: Db) => T): T {
    const db = this.load();
    const out = fn(db);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(db, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
    return out;
  }

  async listBounties(status?: BountyStatus, kind?: ListingKind) {
    return this.load().bounties.filter((b) => (!status || b.status === status) && (!kind || b.kind === kind));
  }
  async getBounty(id: string) {
    return this.load().bounties.find((b) => b.id === id);
  }
  async createBounty(b: NewBounty) {
    const listing = settleListing(b);
    return this.mutate((db) => {
      const bounty: Bounty = { ...listing, id: newId(listing.kind === "role" ? "r" : "b"), status: "open", createdAt: now() };
      db.bounties.push(bounty);
      return bounty;
    });
  }
  async closeBounty(id: string) {
    return this.mutate((db) => {
      const b = db.bounties.find((x) => x.id === id);
      if (!b) throw new Error(`No bounty ${id}`);
      b.status = "closed";
      return b;
    });
  }
  async listSubmissions(filter: { bountyId?: string; status?: SubmissionStatus } = {}) {
    return this.load().submissions.filter(
      (s) => (!filter.bountyId || s.bountyId === filter.bountyId) && (!filter.status || s.status === filter.status),
    );
  }
  async getSubmission(id: string) {
    return this.load().submissions.find((s) => s.id === id);
  }
  async createSubmission(s: NewSubmission) {
    return this.mutate((db) => {
      const bounty = db.bounties.find((b) => b.id === s.bountyId);
      if (!bounty) throw new Error(`No listing ${s.bountyId}`);
      if (bounty.status !== "open") throw new Error(`${bounty.kind === "role" ? "Role" : "Bounty"} ${s.bountyId} is closed`);
      const sub: Submission = { ...s, id: newId("s", 20), status: "pending_review", createdAt: now() };
      db.submissions.push(sub);
      return sub;
    });
  }
  async recordReview(id: string, verdict: "accept" | "reject", reasoning: string, score: number) {
    checkScore(score);
    return this.mutate((db) => {
      const s = db.submissions.find((x) => x.id === id);
      if (!s) throw new Error(`No submission ${id}`);
      if (s.status !== "pending_review") throw new Error(`Submission ${id} already reviewed (${s.status})`);
      s.review = { verdict, reasoning, score, reviewedAt: now() };
      s.status = verdict === "accept" ? "accepted" : "rejected";
      return s;
    });
  }
  async listProposals(status?: ProposalStatus) {
    return this.load().proposals.filter((p) => !status || p.status === status);
  }
  async getProposal(id: string) {
    return this.load().proposals.find((p) => p.id === id);
  }
  async splitPool(bountyId: string) {
    return this.mutate((db) => {
      const bounty = db.bounties.find((x) => x.id === bountyId);
      if (!bounty) throw new Error(`No bounty ${bountyId}`);
      const active = db.proposals.filter((p) => p.bountyId === bountyId && ACTIVE.includes(p.status));
      if (active.length) throw new Error(`Bounty ${bountyId} already has payout proposals. Decline them before splitting again.`);
      const eligible = db.submissions.filter(
        (s) => s.bountyId === bountyId && s.status === "accepted" && (s.review?.score ?? 0) >= MIN_PAYOUT_SCORE,
      );
      if (!eligible.length) throw new Error(`No accepted submissions scored ${MIN_PAYOUT_SCORE} or higher.`);
      const shares = poolShares(toCents(bounty.amount), eligible.map((s) => s.review!.score));
      const created: PayoutProposal[] = [];
      eligible.forEach((s, index) => {
        if (shares[index] <= 0) return;
        const proposal: PayoutProposal = {
          id: newId("p", 20),
          submissionId: s.id,
          bountyId,
          receiverEmail: s.hunterPaypalEmail,
          amount: fromCents(shares[index]),
          currency: bounty.currency,
          justification: s.review!.reasoning,
          status: "awaiting_approval",
          createdAt: now(),
        };
        db.proposals.push(proposal);
        created.push(proposal);
      });
      if (!created.length) throw new Error("Split produced no payouts.");
      return created;
    });
  }
  async setProposalAmount(id: string, amount: string) {
    if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("Amount must look like 50.00");
    return this.mutate((db) => {
      const proposal = db.proposals.find((x) => x.id === id);
      if (!proposal) throw new Error(`No proposal ${id}`);
      if (proposal.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${proposal.status}`);
      const bounty = db.bounties.find((x) => x.id === proposal.bountyId);
      if (!bounty) throw new Error(`No bounty ${proposal.bountyId}`);
      const others = db.proposals
        .filter((p) => p.bountyId === bounty.id && p.id !== id && ACTIVE.includes(p.status))
        .reduce((sum, p) => sum + toCents(p.amount), 0);
      if (others + toCents(amount) > toCents(bounty.amount)) {
        throw new Error(`That amount would exceed the ${bounty.amount} ${bounty.currency} reward pool.`);
      }
      proposal.amount = amount;
      return proposal;
    });
  }
  async claimProposal(id: string, approver: string) {
    return this.mutate((db) => {
      const p = db.proposals.find((x) => x.id === id);
      if (!p || p.status !== "awaiting_approval") return undefined;
      Object.assign(p, { status: "processing", decidedBy: approver, decidedAt: now() });
      return p;
    });
  }
  async updateProposal(id: string, patch: ProposalPatch) {
    return this.mutate((db) => {
      const p = db.proposals.find((x) => x.id === id);
      if (!p) throw new Error(`No proposal ${id}`);
      Object.assign(p, patch);
      return p;
    });
  }
  async ensureDemoBoard() {
    this.mutate((db) => {
      if (!db.bounties.some((b) => b.id === demoBounty.id)) db.bounties.push(demoBounty);
      if (!db.submissions.some((s) => s.id === demoSubmission.id)) db.submissions.push(demoSubmission);
      if (!db.proposals.some((p) => p.id === demoProposal.id)) db.proposals.push(demoProposal);
    });
  }
}

// ---------------------------------------------------------------- Postgres

const SCHEMA = `
create table if not exists bounties (
  id text primary key,
  title text not null,
  description text not null,
  acceptance_criteria jsonb not null,
  amount text not null,
  currency text not null,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  kind text not null default 'bounty',
  category text,
  trial_task text,
  role_pay text
);
alter table bounties add column if not exists kind text not null default 'bounty';
alter table bounties add column if not exists category text;
alter table bounties add column if not exists trial_task text;
alter table bounties add column if not exists role_pay text;
do $$ begin
  alter table bounties add constraint bounties_kind_check check (kind in ('bounty','role'));
exception when duplicate_object then null;
end $$;
create table if not exists submissions (
  id text primary key,
  bounty_id text not null references bounties(id),
  hunter_name text not null,
  hunter_paypal_email text not null,
  content text not null,
  status text not null default 'pending_review' check (status in ('pending_review','accepted','rejected')),
  review jsonb,
  created_at timestamptz not null default now()
);
create table if not exists payout_proposals (
  id text primary key,
  submission_id text not null references submissions(id),
  bounty_id text not null references bounties(id),
  receiver_email text not null,
  amount text not null,
  currency text not null,
  justification text not null,
  status text not null check (status in ('awaiting_approval','processing','paid','declined','failed')),
  paypal_batch_id text,
  paypal_status text,
  error text,
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
-- Money safety: at most one active payout per submission. A pool can pay several people.
drop index if exists payout_proposals_one_active_per_bounty;
create unique index if not exists payout_proposals_one_active_per_submission
  on payout_proposals (submission_id) where status in ('awaiting_approval','processing','paid');
create index if not exists submissions_bounty_idx on submissions (bounty_id);
-- Supabase exposes tables in "public" through its REST API; lock that down.
-- The app connects as the database owner and is unaffected by RLS.
alter table bounties enable row level security;
alter table submissions enable row level security;
alter table payout_proposals enable row level security;
`;

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined);
const opt = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

const toBounty = (r: Row): Bounty => ({
  id: String(r.id),
  title: String(r.title),
  description: String(r.description),
  acceptanceCriteria: r.acceptance_criteria as string[],
  amount: String(r.amount),
  currency: String(r.currency),
  status: r.status as BountyStatus,
  createdAt: iso(r.created_at)!,
  kind: r.kind === "role" ? "role" : "bounty",
  category: isRoleCategory(opt(r.category)) ? (String(r.category) as RoleCategory) : undefined,
  trialTask: opt(r.trial_task),
  rolePay: opt(r.role_pay),
});
const toSubmission = (r: Row): Submission => ({
  id: String(r.id),
  bountyId: String(r.bounty_id),
  hunterName: String(r.hunter_name),
  hunterPaypalEmail: String(r.hunter_paypal_email),
  content: String(r.content),
  status: r.status as SubmissionStatus,
  review: (r.review as Submission["review"]) ?? undefined,
  createdAt: iso(r.created_at)!,
});
const toProposal = (r: Row): PayoutProposal => ({
  id: String(r.id),
  submissionId: String(r.submission_id),
  bountyId: String(r.bounty_id),
  receiverEmail: String(r.receiver_email),
  amount: String(r.amount),
  currency: String(r.currency),
  justification: String(r.justification),
  status: r.status as ProposalStatus,
  paypalBatchId: opt(r.paypal_batch_id),
  paypalStatus: opt(r.paypal_status),
  error: opt(r.error),
  decidedBy: opt(r.decided_by),
  createdAt: iso(r.created_at)!,
  decidedAt: iso(r.decided_at),
});

const PATCH_COLUMNS: Record<keyof ProposalPatch, string> = {
  status: "status",
  paypalBatchId: "paypal_batch_id",
  paypalStatus: "paypal_status",
  error: "error",
  decidedBy: "decided_by",
  decidedAt: "decided_at",
};

class PgStore implements Store {
  private pool: pg.Pool;
  private ready?: Promise<void>;

  constructor(url: string) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    // Supabase uses its own CA. Traffic is encrypted; set DATABASE_SSL=disable only for local databases.
    const ssl = process.env.DATABASE_SSL === "disable" || local ? false : { rejectUnauthorized: false };
    // Strip sslmode from the URL so it can't override the ssl option above.
    const cleaned = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
    this.pool = new pg.Pool({ connectionString: cleaned, ssl, max: 5 });
    this.pool.on("error", (e) => console.error("[db] idle client error:", e.message));
  }

  async ping() {
    try {
      await this.q("select 1");
      return { ok: true as const };
    } catch (e) {
      const code = String((e as { code?: string }).code ?? "unknown");
      const msg = e instanceof Error ? e.message : "";
      const hints: [RegExp, string][] = [
        [/^28P01$|password authentication failed/i, "Wrong database password in DATABASE_URL."],
        [/Tenant or user not found/i, "Username/host mismatch: copy the Session pooler string again (user looks like postgres.<project-ref>)."],
        [/^(ENOTFOUND|EAI_AGAIN)$/, "Host not found: check DATABASE_URL contains pooler.supabase.com, and that the password has no @ # / ? % characters (they break the URL)."],
        [/^(ENETUNREACH|EHOSTUNREACH)$/, "Network unreachable: use the Session pooler string, not Direct connection (IPv6-only)."],
        [/^ECONNREFUSED$/, "Connection refused: check the port (5432 for Session pooler)."],
        [/^ETIMEDOUT$|timeout/i, "Connection timed out: is the Supabase project paused or the host wrong?"],
        [/^3D000$/, "Database name not found: the URL should end with /postgres."],
        [/Invalid URL|ERR_INVALID_URL/i, "DATABASE_URL is not a valid URL: often a password with @ # / ? % characters. Use letters and numbers only."],
      ];
      const hint = hints.find(([re]) => re.test(code) || re.test(msg))?.[1] ?? "See the Render logs for details.";
      // Reset so the next request retries table creation after the problem is fixed.
      this.ready = undefined;
      return { ok: false as const, code, hint };
    }
  }

  private init() {
    this.ready ??= this.pool.query(SCHEMA).then(
      () => undefined,
      (e) => {
        this.ready = undefined; // retry on the next request
        throw e;
      },
    );
    return this.ready;
  }
  private async q(sql: string, params: unknown[] = []): Promise<Row[]> {
    await this.init();
    return (await this.pool.query(sql, params)).rows;
  }

  async listBounties(status?: BountyStatus, kind?: ListingKind) {
    const rows = await this.q(
      `select * from bounties
       where ($1::text is null or status = $1) and ($2::text is null or kind = $2)
       order by created_at`,
      [status ?? null, kind ?? null],
    );
    return rows.map(toBounty);
  }
  async getBounty(id: string) {
    const [r] = await this.q("select * from bounties where id = $1", [id]);
    return r ? toBounty(r) : undefined;
  }
  async createBounty(b: NewBounty) {
    const listing = settleListing(b);
    const [r] = await this.q(
      `insert into bounties (id, title, description, acceptance_criteria, amount, currency, kind, category, trial_task, role_pay)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [
        newId(listing.kind === "role" ? "r" : "b"),
        listing.title,
        listing.description,
        JSON.stringify(listing.acceptanceCriteria),
        listing.amount,
        listing.currency,
        listing.kind,
        listing.category ?? null,
        listing.trialTask ?? null,
        listing.rolePay ?? null,
      ],
    );
    return toBounty(r);
  }
  async closeBounty(id: string) {
    const [r] = await this.q("update bounties set status = 'closed' where id = $1 returning *", [id]);
    if (!r) throw new Error(`No bounty ${id}`);
    return toBounty(r);
  }
  async listSubmissions(filter: { bountyId?: string; status?: SubmissionStatus } = {}) {
    const rows = await this.q(
      `select * from submissions where ($1::text is null or bounty_id = $1) and ($2::text is null or status = $2)
       order by created_at`,
      [filter.bountyId ?? null, filter.status ?? null],
    );
    return rows.map(toSubmission);
  }
  async getSubmission(id: string) {
    const [r] = await this.q("select * from submissions where id = $1", [id]);
    return r ? toSubmission(r) : undefined;
  }
  async createSubmission(s: NewSubmission) {
    const [r] = await this.q(
      `insert into submissions (id, bounty_id, hunter_name, hunter_paypal_email, content)
       select $1, b.id, $3, $4, $5 from bounties b where b.id = $2 and b.status = 'open'
       returning *`,
      [newId("s", 20), s.bountyId, s.hunterName, s.hunterPaypalEmail, s.content],
    );
    if (r) return toSubmission(r);
    const b = await this.getBounty(s.bountyId);
    throw new Error(b ? `${b.kind === "role" ? "Role" : "Bounty"} ${s.bountyId} is closed` : `No listing ${s.bountyId}`);
  }
  async recordReview(id: string, verdict: "accept" | "reject", reasoning: string, score: number) {
    checkScore(score);
    const [r] = await this.q(
      `update submissions set review = $2, status = $3 where id = $1 and status = 'pending_review' returning *`,
      [id, JSON.stringify({ verdict, reasoning, score, reviewedAt: now() }), verdict === "accept" ? "accepted" : "rejected"],
    );
    if (r) return toSubmission(r);
    const s = await this.getSubmission(id);
    throw new Error(s ? `Submission ${id} already reviewed (${s.status})` : `No submission ${id}`);
  }
  async listProposals(status?: ProposalStatus) {
    const rows = status
      ? await this.q("select * from payout_proposals where status = $1 order by created_at", [status])
      : await this.q("select * from payout_proposals order by created_at");
    return rows.map(toProposal);
  }
  async getProposal(id: string) {
    const [r] = await this.q("select * from payout_proposals where id = $1", [id]);
    return r ? toProposal(r) : undefined;
  }
  async splitPool(bountyId: string) {
    const bounty = await this.getBounty(bountyId);
    if (!bounty) throw new Error(`No bounty ${bountyId}`);
    const existing = await this.q(
      "select id from payout_proposals where bounty_id = $1 and status = any($2) limit 1",
      [bountyId, ACTIVE],
    );
    if (existing.length) throw new Error(`Bounty ${bountyId} already has payout proposals. Decline them before splitting again.`);
    const submissions = (await this.listSubmissions({ bountyId, status: "accepted" })).filter(
      (s) => (s.review?.score ?? 0) >= MIN_PAYOUT_SCORE,
    );
    if (!submissions.length) throw new Error(`No accepted submissions scored ${MIN_PAYOUT_SCORE} or higher.`);
    const shares = poolShares(toCents(bounty.amount), submissions.map((s) => s.review!.score));
    const created: PayoutProposal[] = [];
    for (let index = 0; index < submissions.length; index++) {
      if (shares[index] <= 0) continue;
      const submission = submissions[index];
      const [row] = await this.q(
        `insert into payout_proposals (id, submission_id, bounty_id, receiver_email, amount, currency, justification, status)
         values ($1,$2,$3,$4,$5,$6,$7,'awaiting_approval') returning *`,
        [
          newId("p", 20),
          submission.id,
          bountyId,
          submission.hunterPaypalEmail,
          fromCents(shares[index]),
          bounty.currency,
          submission.review!.reasoning,
        ],
      );
      created.push(toProposal(row));
    }
    if (!created.length) throw new Error("Split produced no payouts.");
    return created;
  }
  async setProposalAmount(id: string, amount: string) {
    if (!/^\d+\.\d{2}$/.test(amount)) throw new Error("Amount must look like 50.00");
    const proposal = await this.getProposal(id);
    if (!proposal) throw new Error(`No proposal ${id}`);
    if (proposal.status !== "awaiting_approval") throw new Error(`Proposal ${id} is ${proposal.status}`);
    const bounty = await this.getBounty(proposal.bountyId);
    if (!bounty) throw new Error(`No bounty ${proposal.bountyId}`);
    const rows = await this.q(
      "select amount from payout_proposals where bounty_id = $1 and id <> $2 and status = any($3)",
      [bounty.id, id, ACTIVE],
    );
    const others = rows.reduce((sum, row) => sum + toCents(String(row.amount)), 0);
    if (others + toCents(amount) > toCents(bounty.amount)) {
      throw new Error(`That amount would exceed the ${bounty.amount} ${bounty.currency} reward pool.`);
    }
    const [row] = await this.q("update payout_proposals set amount = $2 where id = $1 returning *", [id, amount]);
    return toProposal(row);
  }
  async claimProposal(id: string, approver: string) {
    const [r] = await this.q(
      `update payout_proposals set status = 'processing', decided_by = $2, decided_at = now()
       where id = $1 and status = 'awaiting_approval' returning *`,
      [id, approver],
    );
    return r ? toProposal(r) : undefined;
  }
  async ensureDemoBoard() {
    await this.q(
      `insert into bounties (id, title, description, acceptance_criteria, amount, currency, status, created_at, kind)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
       on conflict (id) do nothing`,
      [
        demoBounty.id,
        demoBounty.title,
        demoBounty.description,
        JSON.stringify(demoBounty.acceptanceCriteria),
        demoBounty.amount,
        demoBounty.currency,
        demoBounty.status,
        demoBounty.createdAt,
        demoBounty.kind,
      ],
    );
    await this.q(
      `insert into submissions (id, bounty_id, hunter_name, hunter_paypal_email, content, status, review, created_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       on conflict (id) do nothing`,
      [
        demoSubmission.id,
        demoSubmission.bountyId,
        demoSubmission.hunterName,
        demoSubmission.hunterPaypalEmail,
        demoSubmission.content,
        demoSubmission.status,
        JSON.stringify(demoSubmission.review),
        demoSubmission.createdAt,
      ],
    );
    await this.q(
      `insert into payout_proposals
        (id, submission_id, bounty_id, receiver_email, amount, currency, justification, status, paypal_batch_id, paypal_status, decided_by, created_at, decided_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (id) do nothing`,
      [
        demoProposal.id,
        demoProposal.submissionId,
        demoProposal.bountyId,
        demoProposal.receiverEmail,
        demoProposal.amount,
        demoProposal.currency,
        demoProposal.justification,
        demoProposal.status,
        demoProposal.paypalBatchId,
        demoProposal.paypalStatus,
        demoProposal.decidedBy,
        demoProposal.createdAt,
        demoProposal.decidedAt,
      ],
    );
  }
  async updateProposal(id: string, patch: ProposalPatch) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof ProposalPatch, string][];
    const sets = entries.map(([k], i) => `${PATCH_COLUMNS[k]} = $${i + 2}`);
    const [r] = await this.q(
      `update payout_proposals set ${sets.length ? sets.join(", ") : "id = id"} where id = $1 returning *`,
      [id, ...entries.map(([, v]) => v)],
    );
    if (!r) throw new Error(`No proposal ${id}`);
    return toProposal(r);
  }
}

export const store: Store = process.env.DATABASE_URL
  ? new PgStore(process.env.DATABASE_URL)
  : new JsonStore(process.env.BOUNTY_DB_PATH ?? "data/db.json");

export const storageKind = process.env.DATABASE_URL ? "postgres" : "json-file";
