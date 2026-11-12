// Server-rendered HTML. Every dynamic value goes through esc().
import type { Bounty, PayoutProposal, Submission } from "./store.js";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtDate = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const money = (amount: string, currency: string) => `${esc(amount)} ${esc(currency)}`;

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6472;--line:#e3e6ea;--accent:#1f5eff;--ok:#127a3e;--bad:#b42318;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e8eaee;--muted:#9aa3b2;--line:#2a2f3a;--accent:#6b93ff;--ok:#4cc38a;--bad:#ff7b72;--warn:#e3b341}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line)}
.wrap{max-width:960px;margin:0 auto;padding:16px}
header .wrap{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header a.brand{font-weight:700;font-size:18px;color:var(--text);text-decoration:none}
nav a{margin-right:12px;color:var(--muted);text-decoration:none}nav a:hover{color:var(--text)}
.env{margin-left:auto;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.env.live{border-color:var(--bad);color:var(--bad);font-weight:700}
h1{font-size:24px;margin:8px 0 16px}h2{font-size:18px;margin:28px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.muted{color:var(--muted)}.small{font-size:13px}
.amount{font-weight:700;font-size:18px;white-space:nowrap}
.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.warn{color:var(--warn);border-color:var(--warn)}
ul.criteria{margin:8px 0 0;padding-left:20px}
form.stack{display:grid;gap:10px;max-width:560px}
label{display:grid;gap:4px;font-weight:600;font-size:14px}
input,textarea,select{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);width:100%}
textarea{min-height:110px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.secondary{background:transparent;color:var(--text);border-color:var(--line)}
button.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
button:disabled{opacity:.6;cursor:not-allowed}
.inline{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;border:1px solid var(--line);background:var(--card);white-space:pre-wrap}
.flash.error{border-color:var(--bad);color:var(--bad)}
.content{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
.scroll{overflow-x:auto}
`;

export function layout(opts: { title: string; body: string; admin?: boolean; flash?: { msg: string; error?: boolean } }) {
  const env = (process.env.PAYPAL_ENV ?? "sandbox").toLowerCase();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · Gentpay</title><style>${CSS}</style></head><body>
<header><div class="wrap"><a class="brand" href="/">Gentpay</a>
<nav><a href="/">Bounties</a>${opts.admin ? `<a href="/admin">Admin</a>` : ""}</nav>
<span class="env ${env === "live" ? "live" : ""}">PayPal ${esc(env.toUpperCase())}</span></div></header>
<main class="wrap">${opts.flash ? `<div class="flash ${opts.flash.error ? "error" : ""}">${esc(opts.flash.msg)}</div>` : ""}${opts.body}</main>
</body></html>`;
}

const statusBadge = (s: string) => {
  const cls = ["paid", "accepted", "open", "SUCCESS"].includes(s)
    ? "ok"
    : ["rejected", "failed", "declined", "DENIED"].includes(s)
      ? "bad"
      : ["awaiting_approval", "pending_review", "processing", "PENDING"].includes(s)
        ? "warn"
        : "";
  return `<span class="badge ${cls}">${esc(s.replace(/_/g, " "))}</span>`;
};

// ---------- public ----------

export function bountyListPage(bounties: Bounty[]) {
  const items = bounties.length
    ? bounties
        .map(
          (b) => `<div class="card"><div class="row"><div><a href="/bounties/${esc(b.id)}"><strong>${esc(b.title)}</strong></a>
<div class="muted small">${esc(b.acceptanceCriteria.length)} acceptance criteria · posted ${fmtDate(b.createdAt)}</div></div>
<div class="amount">${money(b.amount, b.currency)}</div></div></div>`,
        )
        .join("")
    : `<div class="card muted">No open bounties right now. Check back soon.</div>`;
  return layout({
    title: "Open bounties",
    body: `<h1>Open bounties</h1><p class="muted">Complete a bounty, submit your work, and get paid via PayPal once it's reviewed and approved.</p>${items}`,
  });
}

export function bountyPage(b: Bounty, flash?: { msg: string; error?: boolean }) {
  const open = b.status === "open";
  return layout({
    title: b.title,
    flash,
    body: `<h1>${esc(b.title)}</h1>
<div class="card"><div class="row"><div>${statusBadge(b.status)}</div><div class="amount">${money(b.amount, b.currency)}</div></div>
<p class="content" style="background:none;border:0;padding:0">${esc(b.description)}</p>
<strong>Acceptance criteria</strong><ul class="criteria">${b.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>
${
  open
    ? `<h2>Submit your work</h2>
<form class="stack card" method="post" action="/bounties/${esc(b.id)}/submit">
<label>Your name<input name="hunterName" required maxlength="100"></label>
<label>PayPal email (where you'll be paid)<input name="hunterPaypalEmail" type="email" required maxlength="254"></label>
<label>Your submission<textarea name="content" required maxlength="5000" placeholder="Link to your PR / proof, and a short description of what you did and how it meets each criterion."></textarea></label>
<button type="submit">Submit</button>
<p class="muted small">Submissions are reviewed by an AI agent against the criteria above, and every payout is approved by a person before any money is sent.</p>
</form>`
    : `<div class="card muted">This bounty is closed.</div>`
}`,
  });
}

// ---------- admin ----------

export interface AdminData {
  bounties: Bounty[];
  submissions: Submission[];
  proposals: PayoutProposal[];
  review: { running: boolean; lastRunAt?: string; lastResult?: string; lastError?: string };
}

export function adminPage(d: AdminData, flash?: { msg: string; error?: boolean }) {
  const bountyById = new Map(d.bounties.map((b) => [b.id, b]));
  const subById = new Map(d.submissions.map((s) => [s.id, s]));
  const pendingSubs = d.submissions.filter((s) => s.status === "pending_review");
  const awaiting = d.proposals.filter((p) => p.status === "awaiting_approval");
  const env = (process.env.PAYPAL_ENV ?? "sandbox").toUpperCase();

  const proposalCards = awaiting.length
    ? awaiting
        .map((p) => {
          const s = subById.get(p.submissionId);
          const b = bountyById.get(p.bountyId);
          return `<div class="card"><div class="row"><div><strong>${esc(b?.title ?? p.bountyId)}</strong>
<div class="muted small">to ${esc(s?.hunterName)} &lt;${esc(p.receiverEmail)}&gt; · proposal ${esc(p.id)}</div></div>
<div class="amount">${money(p.amount, p.currency)}</div></div>
<div class="small"><strong>AI review:</strong> ${esc(s?.review?.reasoning)}</div>
<div class="small muted"><strong>Submission:</strong></div><div class="content small">${esc(s?.content)}</div>
<div class="inline">
<form method="post" action="/admin/proposals/${esc(p.id)}/approve" class="inline"
 onsubmit="return confirm('Send ${esc(p.amount)} ${esc(p.currency)} to ${esc(p.receiverEmail)} via PayPal ${esc(env)}?')">
<input name="approver" placeholder="Your name" required maxlength="100" style="width:160px">
<button type="submit">Approve &amp; pay</button></form>
<form method="post" action="/admin/proposals/${esc(p.id)}/decline" class="inline">
<input type="hidden" name="approver" value="admin"><button class="danger" type="submit">Decline</button></form>
</div></div>`;
        })
        .join("")
    : `<div class="card muted">No payouts waiting for approval.</div>`;

  const review = d.review;
  const reviewCard = `<div class="card"><div class="row"><div>
<strong>${pendingSubs.length}</strong> submission(s) waiting for AI review.
${review.lastRunAt ? `<div class="muted small">Last review ${fmtDate(review.lastRunAt)}</div>` : ""}</div>
<form method="post" action="/admin/review"><button type="submit" ${review.running || !pendingSubs.length ? "disabled" : ""}>${review.running ? "Review running… refresh in a moment" : "Run AI review"}</button></form></div>
${review.lastError ? `<div class="flash error small">${esc(review.lastError)}</div>` : ""}
${review.lastResult ? `<details><summary class="small">Last review summary</summary><div class="content small">${esc(review.lastResult)}</div></details>` : ""}</div>`;

  const subRows = d.submissions
    .slice()
    .reverse()
    .map((s) => {
      const b = bountyById.get(s.bountyId);
      return `<tr><td>${fmtDate(s.createdAt)}</td><td>${esc(b?.title ?? s.bountyId)}</td><td>${esc(s.hunterName)}<div class="muted small">${esc(s.hunterPaypalEmail)}</div></td>
<td>${statusBadge(s.status)}${s.review ? `<div class="muted small">${esc(s.review.reasoning)}</div>` : ""}</td></tr>`;
    })
    .join("");

  const payoutRows = d.proposals
    .filter((p) => p.status !== "awaiting_approval")
    .slice()
    .reverse()
    .map(
      (p) => `<tr><td>${fmtDate(p.decidedAt ?? p.createdAt)}</td><td>${esc(bountyById.get(p.bountyId)?.title ?? p.bountyId)}</td><td>${esc(p.receiverEmail)}</td>
<td>${money(p.amount, p.currency)}</td><td>${statusBadge(p.status)} ${p.paypalStatus ? statusBadge(p.paypalStatus) : ""}
${p.paypalBatchId ? `<div class="muted small">batch ${esc(p.paypalBatchId)}</div>` : ""}${p.error ? `<div class="small" style="color:var(--bad)">${esc(p.error.slice(0, 300))}</div>` : ""}
${p.paypalBatchId ? `<form method="post" action="/admin/proposals/${esc(p.id)}/status"><button class="secondary small" type="submit">Refresh status</button></form>` : ""}</td></tr>`,
    )
    .join("");

  const bountyRows = d.bounties
    .slice()
    .reverse()
    .map(
      (b) => `<tr><td><a href="/bounties/${esc(b.id)}">${esc(b.title)}</a></td><td>${money(b.amount, b.currency)}</td><td>${statusBadge(b.status)}</td>
<td>${b.status === "open" ? `<form method="post" action="/admin/bounties/${esc(b.id)}/close"><button class="secondary" type="submit">Close</button></form>` : ""}</td></tr>`,
    )
    .join("");

  return layout({
    title: "Admin",
    admin: true,
    flash,
    body: `<h1>Admin</h1>
<h2>Payouts awaiting your approval</h2>${proposalCards}
<h2>AI review</h2>${reviewCard}
<h2>Create a bounty</h2>
<form class="stack card" method="post" action="/admin/bounties">
<label>Title<input name="title" required maxlength="200"></label>
<label>Description<textarea name="description" required maxlength="5000"></textarea></label>
<label>Acceptance criteria (one per line)<textarea name="criteria" required maxlength="5000" placeholder="PR merged to main&#10;Includes a regression test"></textarea></label>
<div class="inline"><label>Amount<input name="amount" required pattern="\\d+(\\.\\d{2})?" placeholder="50.00" style="width:140px"></label>
<label>Currency<input name="currency" required value="USD" maxlength="3" style="width:90px"></label></div>
<button type="submit">Create bounty</button></form>
<h2>Bounties</h2><div class="card scroll"><table><tr><th>Title</th><th>Amount</th><th>Status</th><th></th></tr>${bountyRows || `<tr><td colspan="4" class="muted">None yet.</td></tr>`}</table></div>
<h2>Submissions</h2><div class="card scroll"><table><tr><th>When</th><th>Bounty</th><th>Hunter</th><th>Status</th></tr>${subRows || `<tr><td colspan="4" class="muted">None yet.</td></tr>`}</table></div>
<h2>Payout history</h2><div class="card scroll"><table><tr><th>When</th><th>Bounty</th><th>To</th><th>Amount</th><th>Status</th></tr>${payoutRows || `<tr><td colspan="5" class="muted">None yet.</td></tr>`}</table></div>`,
  });
}

export function messagePage(title: string, msg: string) {
  return layout({ title, body: `<h1>${esc(title)}</h1><div class="card">${esc(msg)}</div><p><a href="/">← Back to bounties</a></p>` });
}
