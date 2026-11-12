// Web app: public bounty board + password-protected admin dashboard.
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { agentProvider, runAgent } from "./agent.js";
import { approveProposal, declineProposal, refreshPayoutStatus } from "./payouts.js";
import { ROLE_CATEGORIES, storageKind, store, type RoleCategory } from "./store.js";
import { adminPage, bountyPage, homePage, loginPage, messagePage, rolePage, rolesPage, submissionPage } from "./views.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.set("trust proxy", 1); // Render terminates TLS in front of us
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "50kb" }));
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const flashFrom = (q: Request["query"]) =>
  typeof q.ok === "string" ? { msg: q.ok } : typeof q.err === "string" ? { msg: q.err, error: true } : undefined;
const back = (res: Response, path: string, key: "ok" | "err", msg: string) =>
  res.redirect(303, `${path}?${key}=${encodeURIComponent(msg.slice(0, 500))}`);

// ---------- public ----------

app.get("/healthz", async (_req, res) => {
  const db = await store.ping();
  // Always 200 so a database problem never blocks Render deploys; the body says what is wrong.
  res.json({ ok: db.ok, storage: storageKind, ai: agentProvider, ...(db.ok ? {} : { db }) });
});

app.get("/", async (_req, res) => {
  const [bounties, bountyListings, roles, submissions, paid] = await Promise.all([
    store.listBounties("open", "bounty"),
    store.listBounties(undefined, "bounty"),
    store.listBounties("open", "role"),
    store.listSubmissions(),
    store.listProposals("paid"),
  ]);
  const bountyIds = new Set(bountyListings.map((b) => b.id));
  const submissionCounts = new Map<string, number>();
  for (const s of submissions) submissionCounts.set(s.bountyId, (submissionCounts.get(s.bountyId) ?? 0) + 1);
  const bountyPaid = paid.filter((p) => bountyIds.has(p.bountyId));
  const totals = new Map<string, number>();
  for (const p of bountyPaid) totals.set(p.currency, (totals.get(p.currency) ?? 0) + Number(p.amount));
  res.send(
    homePage({
      bounties: bounties.slice().reverse(),
      submissionCounts,
      paidTotals: [...totals].map(([currency, amount]) => ({ currency, amount })),
      contributorsPaid: new Set(bountyPaid.map((p) => p.receiverEmail.toLowerCase())).size,
      openRoles: roles.length,
    }),
  );
});

app.get("/roles", async (req, res) => {
  const category = typeof req.query.category === "string" && (ROLE_CATEGORIES as readonly string[]).includes(req.query.category)
    ? (req.query.category as RoleCategory)
    : undefined;
  const [roles, submissions] = await Promise.all([store.listBounties("open", "role"), store.listSubmissions()]);
  const submissionCounts = new Map<string, number>();
  for (const s of submissions) submissionCounts.set(s.bountyId, (submissionCounts.get(s.bountyId) ?? 0) + 1);
  const listed = category ? roles.filter((r) => r.category === category) : roles;
  res.send(rolesPage({ roles: listed.slice().reverse(), submissionCounts, category, totalOpen: roles.length }));
});

app.get("/roles/:id", async (req, res) => {
  const role = await store.getBounty(req.params.id);
  if (!role) return res.status(404).send(messagePage("Not found", "That role doesn't exist."));
  if (role.kind !== "role") return res.redirect(303, `/bounties/${encodeURIComponent(role.id)}`);
  const subs = await store.listSubmissions({ bountyId: role.id });
  res.send(rolePage(role, subs.length, flashFrom(req.query)));
});

app.get("/bounties/:id", async (req, res) => {
  const b = await store.getBounty(req.params.id);
  if (!b) return res.status(404).send(messagePage("Not found", "That bounty doesn't exist."));
  if (b.kind === "role") return res.redirect(303, `/roles/${encodeURIComponent(b.id)}`);
  const subs = await store.listSubmissions({ bountyId: b.id });
  res.send(bountyPage(b, subs, flashFrom(req.query)));
});

app.get("/submissions/:id", async (req, res) => {
  const s = await store.getSubmission(req.params.id);
  if (!s) return res.status(404).send(messagePage("Not found", "We couldn't find that submission."));
  const [b, proposals] = await Promise.all([store.getBounty(s.bountyId), store.listProposals()]);
  const p = proposals.filter((x) => x.submissionId === s.id).at(-1);
  res.set("Referrer-Policy", "no-referrer");
  res.send(submissionPage(s, b, p, flashFrom(req.query)));
});

const SubmissionForm = z.object({
  hunterName: z.string().trim().min(1).max(100),
  hunterPaypalEmail: z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254)),
  content: z.string().trim().min(10, "Please describe your work (at least 10 characters).").max(5000),
});

async function acceptSubmission(req: Request, res: Response, kind: "bounty" | "role") {
  const id = String(req.params.id);
  const path = `/${kind === "role" ? "roles" : "bounties"}/${encodeURIComponent(id)}`;
  const listing = await store.getBounty(id);
  if (!listing || listing.kind !== kind) {
    return back(res, kind === "role" ? "/roles" : "/", "err", kind === "role" ? "That role is not open." : "That bounty is not open.");
  }
  const parsed = SubmissionForm.safeParse(req.body);
  if (!parsed.success) return back(res, path, "err", parsed.error.issues.map((i) => i.message).join("; "));
  try {
    const sub = await store.createSubmission({ bountyId: id, ...parsed.data });
    const ok = kind === "role"
      ? "Thanks! Your trial was received. Bookmark this page to track it."
      : "Thanks! Your submission was received. Bookmark this page to track it.";
    back(res, `/submissions/${encodeURIComponent(sub.id)}`, "ok", ok);
  } catch (e) {
    back(res, path, "err", errMsg(e));
  }
}

app.post("/bounties/:id/submit", (req, res) => acceptSubmission(req, res, "bounty"));
app.post("/roles/:id/submit", (req, res) => acceptSubmission(req, res, "role"));

// ---------- admin ----------

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const adminSessions = new Set<string>();

function readCookie(req: Request, name: string) {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send(messagePage("Admin disabled", "Set the ADMIN_PASSWORD environment variable to enable the admin dashboard."));
  }
  const session = readCookie(req, "gentpay_admin");
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  const basic = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : "";
  const authed = (session && adminSessions.has(session)) || (basic.length > 0 && safeEqual(basic, ADMIN_PASSWORD));
  if (!authed) {
    if (req.method === "GET") return res.status(401).send(loginPage());
    return res.redirect(303, "/admin");
  }
  // State-changing requests must come from our own pages.
  if (req.method === "POST") {
    const origin = req.get("origin") ?? req.get("referer") ?? "";
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* missing or malformed */
    }
    if (host !== req.get("host")) return res.status(403).send(messagePage("Forbidden", "Cross-site request blocked."));
  }
  next();
}

app.get("/admin/login", (_req, res) => {
  res.redirect(303, "/admin");
});

app.post("/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send(messagePage("Admin disabled", "Set the ADMIN_PASSWORD environment variable to enable the admin dashboard."));
  }
  const password = String(req.body.password ?? "");
  if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).send(loginPage("That password is wrong."));
  const token = randomUUID();
  adminSessions.add(token);
  res.setHeader("Set-Cookie", `gentpay_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  res.redirect(303, "/admin");
});

app.use("/admin", requireAdmin);

// AI review runs in the background so the page doesn't hang on slow model calls.
const review: { running: boolean; lastRunAt?: string; lastResult?: string; lastError?: string } = { running: false };

app.get("/admin", async (req, res) => {
  const [bounties, submissions, proposals] = await Promise.all([
    store.listBounties(),
    store.listSubmissions(),
    store.listProposals(),
  ]);
  res.send(adminPage({ bounties, submissions, proposals, review, ai: agentProvider }, flashFrom(req.query)));
});

const BountyForm = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  criteria: z.string().max(5000),
  amount: z.string().trim().regex(/^\d+(\.\d{2})?$/, "Amount must look like 50 or 50.00"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code like USD"),
});

app.post("/admin/bounties", async (req, res) => {
  const parsed = BountyForm.safeParse(req.body);
  if (!parsed.success) return back(res, "/admin", "err", parsed.error.issues.map((i) => i.message).join("; "));
  const { criteria, amount, ...rest } = parsed.data;
  const acceptanceCriteria = criteria.split(/\r?\n/).map((c) => c.trim()).filter(Boolean);
  if (!acceptanceCriteria.length) return back(res, "/admin", "err", "Add at least one acceptance criterion.");
  const b = await store.createBounty({ ...rest, amount: amount.includes(".") ? amount : `${amount}.00`, acceptanceCriteria });
  back(res, "/admin", "ok", `Bounty "${b.title}" created.`);
});

const RoleForm = BountyForm.extend({
  category: z.enum(ROLE_CATEGORIES),
  trialTask: z.string().trim().min(10, "Describe the paid trial (at least 10 characters).").max(2000),
  rolePay: z.string().trim().max(80).optional(),
});

app.post("/admin/roles", async (req, res) => {
  const parsed = RoleForm.safeParse(req.body);
  if (!parsed.success) return back(res, "/admin", "err", parsed.error.issues.map((i) => i.message).join("; "));
  const { criteria, amount, rolePay, ...rest } = parsed.data;
  const acceptanceCriteria = criteria.split(/\r?\n/).map((c) => c.trim()).filter(Boolean);
  if (!acceptanceCriteria.length) return back(res, "/admin", "err", "Add at least one acceptance criterion.");
  try {
    const role = await store.createBounty({
      ...rest,
      kind: "role",
      acceptanceCriteria,
      amount: amount.includes(".") ? amount : `${amount}.00`,
      rolePay: rolePay || undefined,
    });
    back(res, "/admin", "ok", `Role "${role.title}" is on the roles board.`);
  } catch (e) {
    back(res, "/admin", "err", errMsg(e));
  }
});

app.post("/admin/bounties/:id/score", async (req, res) => {
  const id = String(req.params.id);
  const bounty = await store.getBounty(id);
  if (!bounty) return back(res, "/admin", "err", "That bounty does not exist.");
  if (review.running) return back(res, "/admin", "err", "Scoring is already running.");
  const pending = (await store.listSubmissions({ bountyId: id, status: "pending_review" })).length;
  if (!pending) return back(res, "/admin", "err", "That bounty has nothing waiting to score.");
  review.running = true;
  review.lastError = undefined;
  const label = bounty.kind === "role" ? "role" : "bounty";
  runAgent(
    `Review only the pending submissions for ${label} ${id}, titled "${bounty.title}". Score each one from 0 to 100 against its acceptance criteria and record the review. Then call split_reward_pool once for ${id} if any accepted submission scored 20 or higher. Do not review or split any other listing.`,
  )
    .then((r) => (review.lastResult = r))
    .catch((e) => (review.lastError = `Scoring failed: ${errMsg(e).slice(0, 500)}`))
    .finally(() => {
      review.running = false;
      review.lastRunAt = new Date().toISOString();
    });
  back(res, "/admin", "ok", `Scoring started for "${bounty.title}". Refresh in a minute.`);
});

app.post("/admin/bounties/:id/close", async (req, res) => {
  try {
    await store.closeBounty(req.params.id);
    back(res, "/admin", "ok", "Bounty closed.");
  } catch (e) {
    back(res, "/admin", "err", errMsg(e));
  }
});

app.post("/admin/review", (_req, res) => {
  if (review.running) return back(res, "/admin", "err", "A review is already running.");
  review.running = true;
  review.lastError = undefined;
  runAgent("Review all pending submissions.")
    .then((r) => (review.lastResult = r))
    .catch((e) => (review.lastError = `AI review failed: ${errMsg(e).slice(0, 500)}`))
    .finally(() => {
      review.running = false;
      review.lastRunAt = new Date().toISOString();
    });
  back(res, "/admin", "ok", "AI review started. Refresh this page in a minute to see the results.");
});

app.post("/admin/proposals/:id/amount", async (req, res) => {
  const raw = String(req.body.amount ?? "").trim();
  const amount = raw.includes(".") ? raw : `${raw}.00`;
  try {
    const p = await store.setProposalAmount(req.params.id, amount);
    back(res, "/admin", "ok", `Amount updated to ${p.amount} ${p.currency}.`);
  } catch (e) {
    back(res, "/admin", "err", errMsg(e));
  }
});

app.post("/admin/proposals/:id/approve", async (req, res) => {
  const approver = String(req.body.approver ?? "").trim().slice(0, 100);
  try {
    const p = await approveProposal(req.params.id, approver);
    back(res, "/admin", "ok", `Payout sent: ${p.amount} ${p.currency} to ${p.receiverEmail} (PayPal batch ${p.paypalBatchId}).`);
  } catch (e) {
    back(res, "/admin", "err", `Payout failed: ${errMsg(e)}`);
  }
});

app.post("/admin/proposals/:id/decline", async (req, res) => {
  try {
    await declineProposal(req.params.id, String(req.body.approver ?? "admin").slice(0, 100));
    back(res, "/admin", "ok", "Proposal declined.");
  } catch (e) {
    back(res, "/admin", "err", errMsg(e));
  }
});

app.post("/admin/proposals/:id/status", async (req, res) => {
  try {
    back(res, "/admin", "ok", `PayPal status: ${await refreshPayoutStatus(req.params.id)}`);
  } catch (e) {
    back(res, "/admin", "err", errMsg(e));
  }
});

app.use((_req, res) => {
  res.status(404).send(messagePage("Not found", "That page doesn't exist."));
});

// Errors thrown in async routes (e.g. database unreachable) land here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[server]", err);
  res.status(500).send(messagePage("Something went wrong", "The server hit an error. Please try again in a moment."));
});

store
  .ensureDemoBoard()
  .catch((e) => console.error("[seed]", errMsg(e)))
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Gentpay listening on http://localhost:${PORT} (PayPal ${process.env.PAYPAL_ENV ?? "sandbox"}, storage: ${storageKind})`,
      );
      if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: the admin dashboard is disabled.");
    });
  });
