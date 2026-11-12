// Web app: public bounty board + password-protected admin dashboard.
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { runAgent } from "./agent.js";
import { approveProposal, declineProposal, refreshPayoutStatus } from "./payouts.js";
import { storageKind, store } from "./store.js";
import { adminPage, bountyListPage, bountyPage, messagePage } from "./views.js";

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

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, storage: storageKind });
});

app.get("/", async (_req, res) => {
  res.send(bountyListPage((await store.listBounties("open")).slice().reverse()));
});

app.get("/bounties/:id", async (req, res) => {
  const b = await store.getBounty(req.params.id);
  if (!b) return res.status(404).send(messagePage("Not found", "That bounty doesn't exist."));
  res.send(bountyPage(b, flashFrom(req.query)));
});

const SubmissionForm = z.object({
  hunterName: z.string().trim().min(1).max(100),
  hunterPaypalEmail: z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254)),
  content: z.string().trim().min(10, "Please describe your work (at least 10 characters).").max(5000),
});

app.post("/bounties/:id/submit", async (req, res) => {
  const path = `/bounties/${encodeURIComponent(req.params.id)}`;
  const parsed = SubmissionForm.safeParse(req.body);
  if (!parsed.success) return back(res, path, "err", parsed.error.issues.map((i) => i.message).join("; "));
  try {
    await store.createSubmission({ bountyId: req.params.id, ...parsed.data });
    back(res, path, "ok", "Thanks! Your submission was received and will be reviewed.");
  } catch (e) {
    back(res, path, "err", errMsg(e));
  }
});

// ---------- admin ----------

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send(messagePage("Admin disabled", "Set the ADMIN_PASSWORD environment variable to enable the admin dashboard."));
  }
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  const password = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : "";
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="AgentPay admin", charset="UTF-8"');
    return res.status(401).send(messagePage("Login required", "Enter the admin password (any username)."));
  }
  // CSRF guard: browsers send Basic credentials automatically, so state-changing
  // requests must come from our own pages.
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

app.use("/admin", requireAdmin);

// AI review runs in the background so the page doesn't hang on slow model calls.
const review: { running: boolean; lastRunAt?: string; lastResult?: string; lastError?: string } = { running: false };

app.get("/admin", async (req, res) => {
  const [bounties, submissions, proposals] = await Promise.all([
    store.listBounties(),
    store.listSubmissions(),
    store.listProposals(),
  ]);
  res.send(adminPage({ bounties, submissions, proposals, review }, flashFrom(req.query)));
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

app.listen(PORT, () => {
  console.log(
    `AgentPay listening on http://localhost:${PORT} (PayPal ${process.env.PAYPAL_ENV ?? "sandbox"}, storage: ${storageKind})`,
  );
  if (!ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: the admin dashboard is disabled.");
});
