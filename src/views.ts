// Server-rendered HTML. Every dynamic value goes through esc().
import { ROLE_CATEGORIES, ROLE_CATEGORY_LABELS, type Bounty, type PayoutProposal, type RoleCategory, type Submission } from "./store.js";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtDate = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const money = (amount: string, currency: string) => `${esc(amount)} ${esc(currency)}`;
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
const moneyShort = (amount: string, currency: string) =>
  SYMBOLS[currency] ? `${SYMBOLS[currency]}${esc(amount)}` : `${esc(amount)} ${esc(currency)}`;

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[86400 * 30, "month"], [86400 * 7, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [sec, name] of units) {
    const n = Math.floor(s / sec);
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

const excerpt = (t: string, n = 150) => (t.length > n ? t.slice(0, n).trimEnd() + "…" : t);

const CSS = `
:root{
  --bg:#f6f7fb;--bg2:#eef0f8;--card:#fff;--text:#0f1222;--muted:#5b6178;--line:#e4e6ef;
  --brand:#5446f0;--brand-ink:#fff;--brand-soft:#eceafe;--money:#0e9f6e;--money-soft:#e3f6ee;
  --bad:#c0362c;--bad-soft:#fdecea;--warn:#a15c07;--warn-soft:#fdf3e1;
  --radius:14px;--shadow:0 1px 2px rgba(16,18,40,.04),0 4px 16px rgba(16,18,40,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0c0e16;--bg2:#121522;--card:#151826;--text:#e9ebf5;--muted:#9aa1ba;--line:#262a3d;
  --brand:#8a7dff;--brand-ink:#0c0e16;--brand-soft:#221f45;--money:#3fd39b;--money-soft:#123326;
  --bad:#ff8a80;--bad-soft:#3a1a18;--warn:#f0b85a;--warn-soft:#3a2a10;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.25);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header.site{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header.site .wrap{display:flex;align-items:center;gap:20px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;color:var(--text);letter-spacing:-.01em}
.brand:hover{text-decoration:none}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--brand),#18b4a0);display:grid;place-items:center;color:#fff;font-weight:900;font-size:17px}
nav.main{display:flex;gap:18px;font-size:15px}nav.main a{color:var(--muted)}nav.main a:hover{color:var(--text);text-decoration:none}
.env{margin-left:auto;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--warn-soft);color:var(--warn);white-space:nowrap}
.env.live{background:var(--bad-soft);color:var(--bad)}
main{padding:28px 0 64px}
h1{font-size:30px;line-height:1.2;letter-spacing:-.02em;margin:0 0 12px}
h2{font-size:22px;letter-spacing:-.01em;margin:44px 0 14px}
h3{font-size:17px;margin:0 0 6px}
.muted{color:var(--muted)}.small{font-size:14px}.tiny{font-size:12.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.stack>*+*{margin-top:12px}
/* hero */
.hero{padding:56px 0 28px;text-align:center}
.hero .eyebrow{display:inline-block;font-size:13px;font-weight:600;color:var(--brand);background:var(--brand-soft);padding:5px 12px;border-radius:999px;margin-bottom:18px}
.hero h1{font-size:clamp(32px,6vw,52px);max-width:820px;margin:0 auto 16px}
.hero h1 .accent{background:linear-gradient(90deg,var(--brand),#18b4a0);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p.lead{font-size:clamp(16px,2.2vw,19px);color:var(--muted);max-width:640px;margin:0 auto 26px}
.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:8px;font:inherit;font-weight:600;font-size:15px;padding:11px 18px;border-radius:10px;border:1px solid var(--brand);background:var(--brand);color:var(--brand-ink);cursor:pointer;text-decoration:none}
.btn:hover{text-decoration:none;filter:brightness(1.06)}
.btn.ghost{background:transparent;color:var(--text);border-color:var(--line)}
.btn.ghost:hover{background:var(--bg2)}
.btn.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
.btn.sm{padding:7px 12px;font-size:14px}
.btn:disabled{opacity:.55;cursor:not-allowed}
.trust{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin-top:22px;font-size:14px;color:var(--muted)}
.trust span::before{content:"✓ ";color:var(--money);font-weight:700}
/* stats */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:34px}
.stat{text-align:center;padding:18px}
.stat .num{font-size:28px;font-weight:800;letter-spacing:-.02em}
.stat .lbl{font-size:13.5px;color:var(--muted)}
/* bounty grid */
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.bounty{display:flex;flex-direction:column;gap:10px;color:inherit;transition:transform .12s ease,border-color .12s ease}
.bounty:hover{text-decoration:none;transform:translateY(-2px);border-color:color-mix(in srgb,var(--brand) 45%,var(--line))}
.bounty .top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.bounty h3{font-size:17.5px;line-height:1.3}
.reward{flex:none;font-weight:800;font-size:18px;color:var(--money);background:var(--money-soft);padding:4px 10px;border-radius:9px;white-space:nowrap}
.meta{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.bounty .go{margin-top:auto;font-size:14px;font-weight:600;color:var(--brand)}
.empty{text-align:center;padding:36px 20px;color:var(--muted)}
/* steps */
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;counter-reset:step}
.step{position:relative;padding:20px}
.step::before{counter-increment:step;content:counter(step);display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--brand-soft);color:var(--brand);font-weight:800;margin-bottom:12px}
.step p{margin:0;color:var(--muted);font-size:14.5px}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.feature p{margin:0;color:var(--muted);font-size:14.5px}
.feature .ico{font-size:22px;margin-bottom:8px}
/* bounty page */
.crumbs{font-size:14px;margin-bottom:14px}
.detail{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:20px;align-items:start}
.sticky{position:sticky;top:84px}
.desc{white-space:pre-wrap;word-break:break-word;margin:6px 0 0}
ul.checks{list-style:none;padding:0;margin:10px 0 0}
ul.checks li{display:flex;gap:10px;padding:9px 0;border-top:1px solid var(--line)}
ul.checks li:first-child{border-top:0}
ul.checks li::before{content:"";flex:none;width:18px;height:18px;margin-top:3px;border-radius:5px;border:2px solid var(--brand)}
.kv{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:6px 0;border-top:1px solid var(--line)}
.kv:first-of-type{border-top:0}
/* timeline */
ul.timeline{list-style:none;padding:0;margin:18px 0 0}
.tl{display:flex;gap:14px;position:relative;padding-bottom:18px}
.tl:last-child{padding-bottom:0}
.tl:not(:last-child)::after{content:"";position:absolute;left:13px;top:30px;bottom:2px;width:2px;background:var(--line)}
.tl.done:not(:last-child)::after{background:var(--money)}
.tl .dot{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:14px;font-weight:800;border:2px solid var(--line);background:var(--card);color:#fff;z-index:1}
.tl.done .dot{background:var(--money);border-color:var(--money)}
.tl.current .dot{border-color:var(--brand);box-shadow:0 0 0 4px var(--brand-soft)}
.tl.bad .dot{background:var(--bad);border-color:var(--bad)}
.tl.todo strong{color:var(--muted)}
/* forms */
form.stack{display:grid;gap:12px}
label{display:grid;gap:5px;font-weight:600;font-size:14px}
.hint{font-weight:400;color:var(--muted);font-size:13px}
input,textarea,select{font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);width:100%}
input:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--brand) 55%,transparent);outline-offset:1px;border-color:transparent}
textarea{min-height:130px;resize:vertical}
button{font:inherit}
/* legacy admin pieces */
.row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.amount{font-weight:800;font-size:18px;white-space:nowrap;color:var(--money)}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--bg2);color:var(--muted)}
.badge.ok{background:var(--money-soft);color:var(--money)}.badge.bad{background:var(--bad-soft);color:var(--bad)}.badge.warn{background:var(--warn-soft);color:var(--warn)}
.inline{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap}
.flash{padding:12px 16px;border-radius:12px;margin-bottom:18px;background:var(--money-soft);color:var(--text);border:1px solid color-mix(in srgb,var(--money) 35%,transparent);white-space:pre-wrap}
.flash.error{background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 35%,transparent)}
.content{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}
.card button:not(.btn),form button:not(.btn){padding:9px 14px;border-radius:10px;border:1px solid var(--brand);background:var(--brand);color:var(--brand-ink);font-weight:600;cursor:pointer}
button.secondary{background:transparent!important;color:var(--text)!important;border-color:var(--line)!important}
button.danger{background:transparent!important;color:var(--bad)!important;border-color:var(--bad)!important}
button:disabled{opacity:.55;cursor:not-allowed}
.wrap>.card+.card,.wrap>form.card+.card{margin-top:12px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
th{font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.scroll{overflow-x:auto}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.chip{font-size:13.5px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--card)}
.chip:hover{text-decoration:none;color:var(--text)}
.chip.on{background:var(--brand-soft);color:var(--brand);border-color:transparent}
nav.main a.on{color:var(--text);font-weight:700}
footer.site{border-top:1px solid var(--line);padding:26px 0 40px;font-size:13.5px;color:var(--muted)}
footer.site .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media (max-width:860px){
  .steps{grid-template-columns:repeat(2,1fr)}.features{grid-template-columns:1fr}
  .detail{grid-template-columns:1fr}.sticky{position:static}
}
@media (max-width:560px){
  nav.main .hide-sm{display:none}.stats{grid-template-columns:1fr}.steps{grid-template-columns:1fr}
  .wrap{padding:0 16px}h2{margin-top:34px}
}
`;

export function layout(opts: { title: string; body: string; admin?: boolean; section?: "bounties" | "roles"; refresh?: number; flash?: { msg: string; error?: boolean } }) {
  const env = (process.env.PAYPAL_ENV ?? "sandbox").toLowerCase();
  const on = (section: "bounties" | "roles") => (opts.section === section ? " class=\"on\"" : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · Gentpay</title>${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ""}
<meta name="description" content="Gentpay: find open bounties, submit your work, and get paid through PayPal after a person approves the AI review.">
<style>${CSS}</style></head><body>
<header class="site"><div class="wrap">
<a class="brand" href="/"><span class="logo">G</span>Gentpay</a>
<nav class="main"><a href="/"${on("bounties")}>Bounties</a><a href="/roles"${on("roles")}>Roles</a><a class="hide-sm" href="/#how">How it works</a><a href="/admin">Creators</a></nav>
<span class="env ${env === "live" ? "live" : ""}" title="Payments run in PayPal's ${esc(env)} environment">${env === "live" ? "LIVE payments" : "Sandbox · test money"}</span>
</div></header>
<main><div class="wrap">${opts.flash ? `<div class="flash ${opts.flash.error ? "error" : ""}">${esc(opts.flash.msg)}</div>` : ""}${opts.body}</div></main>
<footer class="site"><div class="wrap"><span>Gentpay · AI-reviewed bounties, paid through the PayPal Payouts API</span>
<span>Not affiliated with PayPal · <a href="https://github.com/krisbuild/agentpay">Source on GitHub</a></span></div></footer>
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

export interface HomeData {
  bounties: Bounty[];
  submissionCounts: Map<string, number>;
  paidTotals: { currency: string; amount: number }[];
  contributorsPaid: number;
  openRoles: number;
}

function bountyCard(b: Bounty, submissions: number) {
  return `<a class="card bounty" href="/bounties/${esc(b.id)}">
<div class="top"><h3>${esc(b.title)}</h3><span class="reward">${moneyShort(b.amount, b.currency)}</span></div>
<div class="muted small">${esc(excerpt(b.description))}</div>
<div class="meta"><span>✓ ${b.acceptanceCriteria.length} criteria</span><span>✎ ${submissions} submission${submissions === 1 ? "" : "s"}</span><span>${esc(timeAgo(b.createdAt))}</span></div>
<span class="go">View &amp; submit →</span></a>`;
}

export function homePage(d: HomeData) {
  const paid = d.paidTotals.length
    ? d.paidTotals.map((t) => moneyShort(t.amount.toFixed(2), t.currency)).join(" + ")
    : "$0";
  const cards = d.bounties.length
    ? `<div class="grid">${d.bounties.map((b) => bountyCard(b, d.submissionCounts.get(b.id) ?? 0)).join("")}</div>`
    : `<div class="card empty">No open bounties right now. Check back soon.</div>`;
  return layout({
    title: "AI-reviewed bounties, paid with PayPal",
    section: "bounties",
    body: `
<section class="hero">
<span class="eyebrow">AI agent · human approval · PayPal payouts</span>
<h1>Post a bounty. <span class="accent">AI reviews the work.</span> Pay contributors in one click.</h1>
<p class="lead">Gentpay's agent checks every submission against your acceptance criteria and proposes the payout. You approve, and the money goes straight to the contributor's PayPal account.</p>
<div class="cta"><a class="btn" href="#bounties">Browse open bounties</a><a class="btn ghost" href="/admin">Post a bounty</a></div>
<div class="trust"><span>AI can't move money</span><span>You approve every payout</span><span>Paid via PayPal</span></div>
<div class="stats">
<div class="card stat"><div class="num">${d.bounties.length}</div><div class="lbl">Open bounties</div></div>
<div class="card stat"><div class="num">${paid}</div><div class="lbl">Paid out to contributors</div></div>
<div class="card stat"><div class="num">${d.contributorsPaid}</div><div class="lbl">Contributors paid</div></div>
</div>
</section>

<section id="bounties">
<div class="section-head"><h2>Open bounties</h2><span class="muted small">Pick one, do the work, get paid via PayPal.</span></div>
${cards}
<p class="muted small">Remote roles with a paid trial are a separate board. <a href="/roles">${d.openRoles ? `${d.openRoles} open` : "See roles"} →</a></p>
</section>

<section id="how">
<h2>How it works</h2>
<div class="steps">
<div class="card step"><h3>Post a bounty</h3><p>Set the reward and clear acceptance criteria for the work you need.</p></div>
<div class="card step"><h3>Contributors submit</h3><p>Anyone can submit their work with the PayPal email they want to be paid at.</p></div>
<div class="card step"><h3>AI agent reviews</h3><p>The agent checks each submission against every criterion and explains its verdict.</p></div>
<div class="card step"><h3>You approve, PayPal pays</h3><p>One click sends the reward through the PayPal Payouts API, to anywhere PayPal works.</p></div>
</div>
</section>

<section>
<h2>Agentic, but safe with money</h2>
<div class="features">
<div class="card feature"><div class="ico">🛡️</div><h3>The AI can't pay anyone</h3><p>The agent can only review and propose. Sending money is a separate, human-only step.</p></div>
<div class="card feature"><div class="ico">🔒</div><h3>Amounts can't be manipulated</h3><p>Scores split the reward pool. The model cannot choose the amount or the recipient.</p></div>
<div class="card feature"><div class="ico">1×</div><h3>Never pays a submission twice</h3><p>One active payout per submission, so a double click cannot send the same share again.</p></div>
</div>
</section>`,
  });
}

export function bountyPage(b: Bounty, submissions: Submission[], flash?: { msg: string; error?: boolean }) {
  const open = b.status === "open";
  const form = open
    ? `<form class="card stack sticky" method="post" action="/bounties/${esc(b.id)}/submit">
<h3>Submit your work</h3>
<label>Your name<input name="hunterName" required maxlength="100" autocomplete="name"></label>
<label>PayPal email <span class="hint">Where the reward will be sent</span><input name="hunterPaypalEmail" type="email" required maxlength="254" autocomplete="email"></label>
<label>Your submission <span class="hint">Link to your PR or proof, and how it meets each criterion</span><textarea name="content" required maxlength="5000" placeholder="https://github.com/org/repo/pull/123&#10;&#10;What I did and how it meets each criterion…"></textarea></label>
<button class="btn" type="submit">Submit for review</button>
<p class="muted tiny" style="margin:0">An AI agent reviews your submission against the criteria. A person approves every payout before any money is sent.</p>
</form>`
    : `<div class="card sticky"><h3>This bounty is closed</h3><p class="muted small" style="margin:0">It is no longer accepting submissions. <a href="/#bounties">See open bounties →</a></p></div>`;
  return layout({
    title: b.title,
    section: "bounties",
    flash,
    body: `<div class="crumbs"><a href="/#bounties">← All bounties</a></div>
<div class="detail">
<div class="stack">
<div class="card">
<div class="row"><div>${statusBadge(b.status)}</div><span class="reward">${moneyShort(b.amount, b.currency)}</span></div>
<h1 style="margin-top:12px">${esc(b.title)}</h1>
<p class="desc">${esc(b.description)}</p>
</div>
<div class="card">
<h3>Acceptance criteria</h3>
<p class="muted small" style="margin:0">The reward pool is split by quality score. A person approves every payout.</p>
<ul class="checks">${b.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
</div>
<div class="card">
<div class="kv"><span class="muted">Reward pool</span><strong>${money(b.amount, b.currency)}</strong></div>
<div class="kv"><span class="muted">Paid via</span><span>PayPal Payouts</span></div>
<div class="kv"><span class="muted">Submissions so far</span><span>${submissions.length}</span></div>
<div class="kv"><span class="muted">Posted</span><span>${esc(timeAgo(b.createdAt))}</span></div>
</div>
${submissions.length ? `<div class="card"><h3>Submissions</h3><div class="stack">${[...submissions].reverse().map((s) => `<div><div class="row"><strong>${esc(s.hunterName)}</strong><span>${statusBadge(s.status)}${s.review ? ` <span class="badge">${esc(String(s.review.score))}/100</span>` : ""}</span></div><p class="muted small" style="margin:4px 0 0">${esc(excerpt(s.content.replace(/\s+/g, " "), 180))}</p></div>`).join("")}</div></div>` : ""}
</div>
<div>${form}</div>
</div>`,
  });
}

export interface RolesData {
  roles: Bounty[];
  submissionCounts: Map<string, number>;
  category?: RoleCategory;
  totalOpen: number;
}

function roleCard(b: Bounty, trials: number) {
  const category = b.category ? ROLE_CATEGORY_LABELS[b.category] : "Role";
  const hire = b.rolePay ? `<span>Hire ${esc(b.rolePay)}</span>` : "";
  return `<a class="card bounty" href="/roles/${esc(b.id)}">
<div class="top"><h3>${esc(b.title)}</h3><span class="reward">${moneyShort(b.amount, b.currency)}</span></div>
<div><span class="badge">${esc(category)}</span></div>
<div class="muted small">${esc(excerpt(b.trialTask || b.description))}</div>
<div class="meta"><span>Trial pool</span>${hire}<span>✎ ${trials} trial${trials === 1 ? "" : "s"}</span><span>${esc(timeAgo(b.createdAt))}</span></div>
<span class="go">View trial →</span></a>`;
}

export function rolesPage(d: RolesData) {
  const chips = [`<a class="chip ${d.category ? "" : "on"}" href="/roles">All</a>`]
    .concat(ROLE_CATEGORIES.map((id) => `<a class="chip ${d.category === id ? "on" : ""}" href="/roles?category=${id}">${esc(ROLE_CATEGORY_LABELS[id])}</a>`))
    .join("");
  const cards = d.roles.length
    ? `<div class="grid">${d.roles.map((b) => roleCard(b, d.submissionCounts.get(b.id) ?? 0)).join("")}</div>`
    : `<div class="card empty">${d.totalOpen ? "No open roles in this category." : "No open roles yet. Bounties stay on the main board."} <a href="/">Back to bounties</a></div>`;
  return layout({
    title: "Remote roles",
    section: "roles",
    body: `<div class="crumbs"><a href="/">← Bounties</a></div>
<div class="section-head"><h1>Remote roles</h1><span class="muted small">${d.totalOpen} open</span></div>
<p class="muted">These are jobs a short paid trial can prove: writing, design, engineering, research, video, support, and translation. The price on the card is the trial pool. Stated hire pay is not sent by Gentpay.</p>
<div class="chips">${chips}</div>
${cards}`,
  });
}

export function rolePage(b: Bounty, trials: number, flash?: { msg: string; error?: boolean }) {
  const open = b.status === "open";
  const category = b.category ? ROLE_CATEGORY_LABELS[b.category] : "Role";
  const form = open
    ? `<form class="card stack sticky" method="post" action="/roles/${esc(b.id)}/submit">
<h3>Submit your trial</h3>
<label>Your name<input name="hunterName" required maxlength="100" autocomplete="name"></label>
<label>PayPal email <span class="hint">Where the trial payment will be sent</span><input name="hunterPaypalEmail" type="email" required maxlength="254" autocomplete="email"></label>
<label>Your trial <span class="hint">The sample the role asks for, and how it meets each criterion</span><textarea name="content" required maxlength="5000" placeholder="Link to the sample, then how it meets each criterion…"></textarea></label>
<button class="btn" type="submit">Submit trial</button>
<p class="muted tiny" style="margin:0">The trial pool is split by score. A person approves every payout. Hire pay is not sent from this page.</p>
</form>`
    : `<div class="card sticky"><h3>This role is closed</h3><p class="muted small" style="margin:0">It is no longer accepting trials. <a href="/roles">See open roles →</a></p></div>`;
  return layout({
    title: b.title,
    section: "roles",
    flash,
    body: `<div class="crumbs"><a href="/roles">← All roles</a></div>
<div class="detail">
<div class="stack">
<div class="card">
<div class="row"><div>${statusBadge(b.status)} <span class="badge">${esc(category)}</span></div><span class="reward">${moneyShort(b.amount, b.currency)}</span></div>
<h1 style="margin-top:12px">${esc(b.title)}</h1>
<p class="desc">${esc(b.description)}</p>
</div>
<div class="card">
<h3>Paid trial</h3>
<p class="desc">${esc(b.trialTask ?? "")}</p>
</div>
<div class="card">
<h3>How the trial is scored</h3>
<ul class="checks">${b.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
</div>
<div class="card">
<div class="kv"><span class="muted">Trial pool</span><strong>${money(b.amount, b.currency)}</strong></div>
${b.rolePay ? `<div class="kv"><span class="muted">Hire pay</span><span>${esc(b.rolePay)} · not paid here</span></div>` : ""}
<div class="kv"><span class="muted">Trials so far</span><span>${trials}</span></div>
<div class="kv"><span class="muted">Posted</span><span>${esc(timeAgo(b.createdAt))}</span></div>
</div>
</div>
<div>${form}</div>
</div>`,
  });
}

// ---------- submission status (hunter) ----------

const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  return d ? `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}` : "•••";
};

type StepState = "done" | "current" | "todo" | "bad";
const stepRow = (state: StepState, title: string, detail: string) =>
  `<li class="tl ${state}"><span class="dot">${state === "done" ? "✓" : state === "bad" ? "✕" : ""}</span><div><strong>${esc(title)}</strong><div class="muted small">${detail}</div></div></li>`;

export function submissionPage(
  s: Submission,
  b: Bounty | undefined,
  p: PayoutProposal | undefined,
  flash?: { msg: string; error?: boolean },
) {
  const reviewed = s.status !== "pending_review";
  const rejected = s.status === "rejected";
  const paid = p?.status === "paid";
  const declined = p?.status === "declined";
  const failed = p?.status === "failed";

  const steps = [
    stepRow("done", "Submitted", esc(timeAgo(s.createdAt))),
    stepRow(
      reviewed ? (rejected ? "bad" : "done") : "current",
      reviewed ? (rejected ? "Not accepted by AI review" : "Accepted by AI review") : "AI review",
      reviewed
        ? esc(s.review?.reviewedAt ? timeAgo(s.review.reviewedAt) : "")
        : "Waiting for the AI agent to check your work against the criteria.",
    ),
  ];
  if (!rejected) {
    steps.push(
      stepRow(
        paid ? "done" : declined ? "bad" : reviewed ? "current" : "todo",
        declined ? "Payout declined" : paid ? "Approved" : "Human approval",
        declined
          ? "The maintainer declined this payout."
          : paid
            ? esc(p?.decidedAt ? timeAgo(p.decidedAt) : "")
            : "A person checks the AI's recommendation before any money is sent.",
      ),
      stepRow(
        paid ? "done" : failed ? "bad" : "todo",
        paid ? "Paid" : failed ? "Payment failed" : "Paid via PayPal",
        paid
          ? `${money(p!.amount, p!.currency)} sent to your PayPal account${p!.paypalBatchId ? ` · PayPal batch ${esc(p!.paypalBatchId)}` : ""}`
          : failed
            ? "The payment didn't go through. The maintainer can see the error."
            : "The reward is sent to your PayPal email.",
      ),
    );
  }

  const headline = paid
    ? "You've been paid 🎉"
    : rejected
      ? "Your submission wasn't accepted"
      : reviewed
        ? "Accepted, waiting for approval"
        : "Your submission is under review";

  const backHref = b?.kind === "role" ? `/roles/${esc(b.id)}` : b ? `/bounties/${esc(b.id)}` : "/";
  const listingLabel = b?.kind === "role" ? "Role" : "Bounty";
  return layout({
    title: "Submission status",
    section: b?.kind === "role" ? "roles" : "bounties",
    flash,
    body: `<div class="crumbs"><a href="${backHref}">← ${b ? esc(b.title) : "All bounties"}</a></div>
<div class="detail">
<div class="stack">
<div class="card">
<div class="row"><span class="muted small">Submission status</span>${b ? `<span class="reward">${moneyShort(b.amount, b.currency)}</span>` : ""}</div>
<h1 style="margin-top:10px">${headline}</h1>
<p class="muted small" style="margin:0">Bookmark this page to check your status any time.</p>
<ul class="timeline">${steps.join("")}</ul>
</div>
${s.review ? `<div class="card"><h3>AI review</h3><p class="desc small">${esc(s.review.reasoning)}</p></div>` : ""}
</div>
<div class="card sticky">
<h3>Your submission</h3>
<div class="kv"><span class="muted">Name</span><span>${esc(s.hunterName)}</span></div>
<div class="kv"><span class="muted">PayPal</span><span>${esc(maskEmail(s.hunterPaypalEmail))}</span></div>
<div class="kv"><span class="muted">${listingLabel}</span><span>${b ? esc(b.title) : ""}</span></div>
<div class="content small">${esc(s.content)}</div>
</div>
</div>`,
  });
}

// ---------- admin ----------

export interface AdminData {
  bounties: Bounty[];
  submissions: Submission[];
  proposals: PayoutProposal[];
  review: { running: boolean; lastRunAt?: string; lastResult?: string; lastError?: string };
  ai: string;
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
<div class="small"><strong>Score:</strong> ${s?.review ? esc(String(s.review.score)) : "—"}/100</div>
<div class="small"><strong>AI review:</strong> ${esc(s?.review?.reasoning)}</div>
<div class="small muted"><strong>Submission:</strong></div><div class="content small">${esc(s?.content)}</div>
<form method="post" action="/admin/proposals/${esc(p.id)}/amount" class="inline">
<input name="amount" value="${esc(p.amount)}" required pattern="\\d+(\\.\\d{2})?" style="width:120px">
<button type="submit">Save amount</button></form>
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
  const aiName = d.ai === "claude" ? "Claude" : d.ai === "openai" ? "OpenAI" : "Gemini";
  const reviewCard = `<div class="card"><div class="row"><div>
<strong>${pendingSubs.length}</strong> submission(s) waiting for AI review.
${review.lastRunAt ? `<div class="muted small">Last review ${fmtDate(review.lastRunAt)}</div>` : ""}</div>
<form method="post" action="/admin/review"><button type="submit" ${review.running || !pendingSubs.length ? "disabled" : ""}>${review.running ? `${aiName} is scoring… (this page refreshes itself)` : `Score every pending submission`}</button></form></div>
${review.lastError ? `<div class="flash error small">${esc(review.lastError)}</div>` : ""}
${review.lastResult ? `<details><summary class="small">Last review summary</summary><div class="content small">${esc(review.lastResult)}</div></details>` : ""}</div>`;

  const subRows = d.submissions
    .slice()
    .reverse()
    .map((s) => {
      const b = bountyById.get(s.bountyId);
      return `<tr><td>${fmtDate(s.createdAt)}<div><a class="small" href="/submissions/${esc(s.id)}">status page</a></div></td><td>${esc(b?.title ?? s.bountyId)}</td><td>${esc(s.hunterName)}<div class="muted small">${esc(s.hunterPaypalEmail)}</div></td>
<td>${statusBadge(s.status)}${s.review ? `<div class="muted small">${esc(String(s.review.score))}/100 · ${esc(s.review.reasoning)}</div>` : ""}</td></tr>`;
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

  const pendingFor = (id: string) => d.submissions.filter((s) => s.bountyId === id && s.status === "pending_review").length;
  const listingRow = (b: Bounty) => {
    const href = b.kind === "role" ? `/roles/${esc(b.id)}` : `/bounties/${esc(b.id)}`;
    const extra = b.kind === "role" && b.category ? `<div class="muted small">${esc(ROLE_CATEGORY_LABELS[b.category])}</div>` : "";
    return `<tr><td><a href="${href}">${esc(b.title)}</a>${extra}</td><td>${money(b.amount, b.currency)}</td><td>${statusBadge(b.status)}</td>
<td class="inline">${b.status === "open" ? `<form method="post" action="/admin/bounties/${esc(b.id)}/score"><button type="submit" ${review.running || !pendingFor(b.id) ? "disabled" : ""}>${review.running ? "Scoring…" : "Score submission"}</button></form><form method="post" action="/admin/bounties/${esc(b.id)}/close"><button class="secondary" type="submit">Close</button></form>` : ""}</td></tr>`;
  };
  const bountyRows = d.bounties.filter((b) => b.kind !== "role").slice().reverse().map(listingRow).join("");
  const roleRows = d.bounties.filter((b) => b.kind === "role").slice().reverse().map(listingRow).join("");
  const categoryOptions = ROLE_CATEGORIES.map((id) => `<option value="${id}">${esc(ROLE_CATEGORY_LABELS[id])}</option>`).join("");

  return layout({
    title: "Creator panel",
    admin: true,
    flash,
    refresh: review.running ? 6 : undefined,
    body: `<div class="section-head"><h1>Creator panel</h1><span class="muted small">Scoring help: <strong>${aiName}</strong></span></div>
${pendingSubs.length ? `<div class="card" style="margin:16px 0"><div class="row"><div><h2 style="margin:0">Score the waiting work</h2><p class="muted small" style="margin:6px 0 0">${pendingSubs.length} submission${pendingSubs.length === 1 ? "" : "s"} waiting for a score.</p></div><form method="post" action="/admin/review"><button class="btn" type="submit" ${review.running ? "disabled" : ""}>${review.running ? "Scoring…" : "Score now"}</button></form></div></div>` : ""}
<p class="muted">List a bounty, then ask ${aiName} to score the submissions against your criteria. The score splits the pool. You still approve every payout, and the model cannot choose the amount or the recipient.</p>
<div class="stats" style="margin-top:8px">
<div class="card stat"><div class="num">${d.bounties.filter((b) => b.kind !== "role" && b.status === "open").length}</div><div class="lbl">Open bounties</div></div>
<div class="card stat"><div class="num">${pendingSubs.length}</div><div class="lbl">Waiting to be scored</div></div>
<div class="card stat"><div class="num">${awaiting.length}</div><div class="lbl">Payouts awaiting approval</div></div>
</div>
<h2>List a bounty</h2>
<form class="stack card" method="post" action="/admin/bounties">
<label>Title<input name="title" required maxlength="200" placeholder="Fix the login redirect"></label>
<label>What needs to be done<textarea name="description" required maxlength="5000"></textarea></label>
<label>How it will be scored <span class="hint">One criterion per line. The model scores 0–100 against these.</span><textarea name="criteria" required maxlength="5000" placeholder="Pull request is merged&#10;Includes a regression test"></textarea></label>
<div class="inline"><label>Reward pool<input name="amount" required pattern="\\d+(\\.\\d{2})?" placeholder="50.00" style="width:140px"></label>
<label>Currency<input name="currency" required value="USD" maxlength="3" style="width:90px"></label></div>
<button type="submit">List bounty</button></form>
<h2>Your bounties</h2>
<p class="muted small">Score is enabled when that bounty has work waiting. Scores under 20 are left unpaid.</p>
<div class="card scroll"><table><tr><th>Title</th><th>Pool</th><th>Status</th><th></th></tr>${bountyRows || `<tr><td colspan="4" class="muted">None yet.</td></tr>`}</table></div>
<h2>Score help</h2>${reviewCard}
<h2>Payouts awaiting your approval</h2>${proposalCards}
<h2>Add a role</h2>
<p class="muted small">Additional board. Only writing, design, engineering, research, video, support, and translation. The pool pays the trial. Hire pay is shown to applicants and is never sent.</p>
<form class="stack card" method="post" action="/admin/roles">
<label>Title<input name="title" required maxlength="200"></label>
<label>The role<textarea name="description" required maxlength="5000" placeholder="What the hire will do"></textarea></label>
<label>Category<select name="category" required>${categoryOptions}</select></label>
<label>Paid trial<textarea name="trialTask" required maxlength="2000" placeholder="Write a 150-word product description from the brief"></textarea></label>
<label>How the trial is scored (one per line)<textarea name="criteria" required maxlength="5000" placeholder="Matches the brief&#10;Ready to use"></textarea></label>
<div class="inline"><label>Trial pool<input name="amount" required pattern="\\d+(\\.\\d{2})?" placeholder="50.00" style="width:140px"></label>
<label>Currency<input name="currency" required value="USD" maxlength="3" style="width:90px"></label>
<label>Hire pay <span class="hint">Display only</span><input name="rolePay" maxlength="80" placeholder="4000 USD / month" style="width:220px"></label></div>
<button type="submit">Add role</button></form>
<h2>Roles</h2><div class="card scroll"><table><tr><th>Title</th><th>Trial pool</th><th>Status</th><th></th></tr>${roleRows || `<tr><td colspan="4" class="muted">None yet.</td></tr>`}</table></div>
<h2>Submissions</h2><div class="card scroll"><table><tr><th>When</th><th>Bounty</th><th>Hunter</th><th>Status</th></tr>${subRows || `<tr><td colspan="4" class="muted">None yet.</td></tr>`}</table></div>
<h2>Payout history</h2><div class="card scroll"><table><tr><th>When</th><th>Bounty</th><th>To</th><th>Amount</th><th>Status</th></tr>${payoutRows || `<tr><td colspan="5" class="muted">None yet.</td></tr>`}</table></div>`,
  });
}

export function loginPage(error?: string) {
  return layout({
    title: "Creator sign in",
    body: `<form class="card stack" method="post" action="/admin/login" style="max-width:420px;margin:40px auto">
<h1>Creator sign in</h1>
<p class="muted small" style="margin:0">Enter the creator password. There is no username.</p>
${error ? `<div class="flash error">${esc(error)}</div>` : ""}
<label>Password<input name="password" type="password" required autofocus autocomplete="current-password"></label>
<button class="btn" type="submit">Sign in</button>
</form>`,
  });
}

export function messagePage(title: string, msg: string) {
  return layout({
    title,
    body: `<div class="card" style="max-width:560px;margin:40px auto;text-align:center"><h1>${esc(title)}</h1><p class="muted">${esc(msg)}</p><a class="btn" href="/">Back to bounties</a></div>`,
  });
}
