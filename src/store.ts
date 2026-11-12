// Storage for bounties, submissions and payout proposals.
//
// - DATABASE_URL set   -> Postgres (e.g. Supabase). Tables are created on first use.
// - DATABASE_URL unset -> a local JSON file (BOUNTY_DB_PATH, default data/db.json), for development.
//
// Both backends enforce the same money-safety rules:
// - at most one active (awaiting/processing/paid) payout proposal per bounty
// - a proposal can only be claimed for payment once (claimProposal is atomic)
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

export type BountyStatus = "open" | "closed";
export type SubmissionStatus = "pending_review" | "accepted" | "rejected";
export type ProposalStatus = "awaiting_approval" | "processing" | "paid" | "declined" | "failed";

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
  paypalStatus?: string;
  error?: string;
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
}

export type NewBounty = Omit<Bounty, "id" | "status" | "createdAt">;
export type NewSubmission = Omit<Submission, "id" | "status" | "createdAt" | "review">;
type ProposalPatch = Partial<Pick<PayoutProposal, "status" | "paypalBatchId" | "paypalStatus" | "error" | "decidedBy" | "decidedAt">>;

export interface Store {
  /** Connectivity check for /healthz. Never includes credentials. */
  ping(): Promise<{ ok: true } | { ok: false; code: string; hint: string }>;
  listBounties(status?: BountyStatus): Promise<Bounty[]>;
  getBounty(id: string): Promise<Bounty | undefined>;
  createBounty(b: NewBounty): Promise<Bounty>;
  closeBounty(id: string): Promise<Bounty>;
  listSubmissions(filter?: { bountyId?: string; status?: SubmissionStatus }): Promise<Submission[]>;
  getSubmission(id: string): Promise<Submission | undefined>;
  createSubmission(s: NewSubmission): Promise<Submission>;
  recordReview(id: string, verdict: "accept" | "reject", reasoning: string): Promise<Submission>;
  listProposals(status?: ProposalStatus): Promise<PayoutProposal[]>;
  getProposal(id: string): Promise<PayoutProposal | undefined>;
  /** Amount and recipient are copied from the stored bounty/submission, never from model output. */
  createProposal(submissionId: string, justification: string): Promise<PayoutProposal>;
  /** Atomically moves awaiting_approval -> processing. Returns undefined if it was not awaiting approval. */
  claimProposal(id: string, approver: string): Promise<PayoutProposal | undefined>;
  updateProposal(id: string, patch: ProposalPatch): Promise<PayoutProposal>;
}

const now = () => new Date().toISOString();
const newId = (prefix: string, len = 8) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, len)}`;
const ACTIVE: ProposalStatus[] = ["awaiting_approval", "processing", "paid"];

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
    return JSON.parse(readFileSync(this.path, "utf8")) as Db;
  }
  private mutate<T>(fn: (db: Db) => T): T {
    const db = this.load();
    const out = fn(db);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(db, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
    return out;
  }

  async listBounties(status?: BountyStatus) {
    return this.load().bounties.filter((b) => !status || b.status === status);
  }
  async getBounty(id: string) {
    return this.load().bounties.find((b) => b.id === id);
  }
  async createBounty(b: NewBounty) {
    return this.mutate((db) => {
      const bounty: Bounty = { ...b, id: newId("b"), status: "open", createdAt: now() };
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
      if (!bounty) throw new Error(`No bounty ${s.bountyId}`);
      if (bounty.status !== "open") throw new Error(`Bounty ${s.bountyId} is closed`);
      const sub: Submission = { ...s, id: newId("s", 20), status: "pending_review", createdAt: now() };
      db.submissions.push(sub);
      return sub;
    });
  }
  async recordReview(id: string, verdict: "accept" | "reject", reasoning: string) {
    return this.mutate((db) => {
      const s = db.submissions.find((x) => x.id === id);
      if (!s) throw new Error(`No submission ${id}`);
      if (s.status !== "pending_review") throw new Error(`Submission ${id} already reviewed (${s.status})`);
      s.review = { verdict, reasoning, reviewedAt: now() };
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
  async createProposal(submissionId: string, justification: string) {
    return this.mutate((db) => {
      const s = db.submissions.find((x) => x.id === submissionId);
      if (!s) throw new Error(`No submission ${submissionId}`);
      if (s.status !== "accepted") throw new Error(`Submission ${submissionId} is not accepted`);
      const b = db.bounties.find((x) => x.id === s.bountyId)!;
      const dup = db.proposals.find((p) => p.bountyId === b.id && ACTIVE.includes(p.status));
      if (dup) throw new Error(`Bounty ${b.id} already has proposal ${dup.id} (${dup.status})`);
      const p: PayoutProposal = {
        id: newId("p", 20),
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
      if (patch.status === "paid") {
        const b = db.bounties.find((x) => x.id === p.bountyId);
        if (b) b.status = "closed";
      }
      return p;
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
  created_at timestamptz not null default now()
);
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
-- Money safety: at most one active payout per bounty, enforced by the database.
create unique index if not exists payout_proposals_one_active_per_bounty
  on payout_proposals (bounty_id) where status in ('awaiting_approval','processing','paid');
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

  async listBounties(status?: BountyStatus) {
    const rows = status
      ? await this.q("select * from bounties where status = $1 order by created_at", [status])
      : await this.q("select * from bounties order by created_at");
    return rows.map(toBounty);
  }
  async getBounty(id: string) {
    const [r] = await this.q("select * from bounties where id = $1", [id]);
    return r ? toBounty(r) : undefined;
  }
  async createBounty(b: NewBounty) {
    const [r] = await this.q(
      `insert into bounties (id, title, description, acceptance_criteria, amount, currency)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [newId("b"), b.title, b.description, JSON.stringify(b.acceptanceCriteria), b.amount, b.currency],
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
    throw new Error(b ? `Bounty ${s.bountyId} is closed` : `No bounty ${s.bountyId}`);
  }
  async recordReview(id: string, verdict: "accept" | "reject", reasoning: string) {
    const [r] = await this.q(
      `update submissions set review = $2, status = $3 where id = $1 and status = 'pending_review' returning *`,
      [id, JSON.stringify({ verdict, reasoning, reviewedAt: now() }), verdict === "accept" ? "accepted" : "rejected"],
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
  async createProposal(submissionId: string, justification: string) {
    const s = await this.getSubmission(submissionId);
    if (!s) throw new Error(`No submission ${submissionId}`);
    if (s.status !== "accepted") throw new Error(`Submission ${submissionId} is not accepted`);
    try {
      const [r] = await this.q(
        `insert into payout_proposals (id, submission_id, bounty_id, receiver_email, amount, currency, justification, status)
         select $1, s.id, b.id, s.hunter_paypal_email, b.amount, b.currency, $3, 'awaiting_approval'
         from submissions s join bounties b on b.id = s.bounty_id where s.id = $2 returning *`,
        [newId("p", 20), submissionId, justification],
      );
      return toProposal(r);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        const [dup] = await this.q(
          "select id, status from payout_proposals where bounty_id = $1 and status = any($2)",
          [s.bountyId, ACTIVE],
        );
        throw new Error(`Bounty ${s.bountyId} already has proposal ${dup?.id} (${dup?.status})`);
      }
      throw e;
    }
  }
  async claimProposal(id: string, approver: string) {
    const [r] = await this.q(
      `update payout_proposals set status = 'processing', decided_by = $2, decided_at = now()
       where id = $1 and status = 'awaiting_approval' returning *`,
      [id, approver],
    );
    return r ? toProposal(r) : undefined;
  }
  async updateProposal(id: string, patch: ProposalPatch) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof ProposalPatch, string][];
    const sets = entries.map(([k], i) => `${PATCH_COLUMNS[k]} = $${i + 2}`);
    const [r] = await this.q(
      `update payout_proposals set ${sets.length ? sets.join(", ") : "id = id"} where id = $1 returning *`,
      [id, ...entries.map(([, v]) => v)],
    );
    if (!r) throw new Error(`No proposal ${id}`);
    if (patch.status === "paid") await this.q("update bounties set status = 'closed' where id = $1", [r.bounty_id]);
    return toProposal(r);
  }
}

export const store: Store = process.env.DATABASE_URL
  ? new PgStore(process.env.DATABASE_URL)
  : new JsonStore(process.env.BOUNTY_DB_PATH ?? "data/db.json");

export const storageKind = process.env.DATABASE_URL ? "postgres" : "json-file";
