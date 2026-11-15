#!/usr/bin/env node
/*
 * GitTree: grows a tree from your public GitHub activity and writes it as an animated SVG.
 * Zero dependencies. Node 18+.
 *
 *   node tree.mjs --user <login> --out assets/tree.svg     fetch (needs GITHUB_TOKEN) + render
 *   node tree.mjs --data data.json --out tree.svg           render from saved data
 *   --save-data file.json     keep the fetched data
 *   --date YYYY-MM-DD         draw the tree as it was on that date
 *   --season-date YYYY-MM-DD  take the season from this date instead (previews)
 *   --exclude "HTML,CSS"      languages that never get a limb (default: markup and config, see EXCLUDE)
 *
 * How the tree is built
 *   trunk height ......... all-time contributions (log scale; full-grown at about 3,200)
 *   trunk girth .......... number of days you've contributed (thickens a little every active day)
 *   limbs ................ your top languages, scored half by how many repos use them, half by code size;
 *                          the strongest is the central leader, the rest alternate outward
 *   branches on a limb ... one per repo in that language, oldest nearest the trunk, newest near the tip;
 *                          a repo's branch length and sub-branching follow that repo's code size
 *   leaves ............... on each repo's branch, denser the more you committed to it in the last 90 days
 *   leaf / bud colour .... the language's GitHub colour blended with the season
 *   blossoms / fruit ..... pull requests merged in the last year
 *   birds ................ stars across your repos (1, 10, 50, 200)
 *   grass ................ your last 371 days, one blade per day, height = that day's contributions
 *   sun .................. current streak (no streak: behind a cloud)
 *   wind ................. activity in the last 14 days
 *   season ............... today's date, blended gradually through the year
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* ---------------- utils ---------------- */
const W = 900, H = 340, GY = 300;
const EXCLUDE = ['HTML', 'CSS', 'SCSS', 'Sass', 'Less', 'Dockerfile', 'Makefile', 'Jupyter Notebook', 'Procfile', 'Batchfile'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, t) => a + (b - a) * t;
const f1 = n => Math.round(n * 10) / 10;
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 };
const rng = seed => { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } };
const hx = h => { h = (h || '#7a9a6a').replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0) };
const mix = (a, b, t) => '#' + hx(a).map((v, i) => Math.round(lerp(v, hx(b)[i], clamp(t, 0, 1))).toString(16).padStart(2, '0')).join('');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DAY = 864e5;

/* ---------------- fetch (GitHub GraphQL) ---------------- */
// GitHub's GraphQL API fails transiently now and then (5xx, or a 200 with "Something went wrong"), and can
// rate-limit with 403/429; retry those with backoff so a scheduled run doesn't fail on a hiccup
async function gql(query, variables, token, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    let r, j = {};
    try {
      r = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gittree' }, body: JSON.stringify({ query, variables }) });
      j = await r.json().catch(() => ({}));
    } catch (e) { if (attempt >= tries) throw e }
    if (r && r.ok && !j.errors) return j.data;
    const msg = r ? `GitHub API ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 600)}` : 'network error';
    const transient = !r || r.status >= 500 || r.status === 429 || (r.status === 403 && /rate limit/i.test(msg)) || /something went wrong|timeout|timed out/i.test(msg);
    if (!transient || attempt >= tries) throw new Error(msg);
    const wait = Math.min(60, Number(r?.headers.get('retry-after')) || 2 ** attempt * 2);
    console.error(`${msg.slice(0, 160)}; retrying in ${wait}s (attempt ${attempt + 1} of ${tries})`);
    await new Promise(res => setTimeout(res, wait * 1000));
  }
}
async function fetchData(login, token) {
  const Q_USER = `query($login:String!){user(login:$login){login createdAt
    repositories(first:100,ownerAffiliations:[OWNER],privacy:PUBLIC,isFork:false,orderBy:{field:PUSHED_AT,direction:DESC}){nodes{
      name createdAt pushedAt stargazerCount primaryLanguage{name color}
      languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name color}}}}}
    pullRequests(states:[MERGED],first:100,orderBy:{field:CREATED_AT,direction:DESC}){nodes{mergedAt}}}}`;
  // the yearly calls only need the calendar; per-repo commits are a heavier query, so it runs once for the last 90 days
  const Q_CAL = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){
    contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`;
  const Q_RECENT = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){
    commitContributionsByRepository(maxRepositories:100){repository{name owner{login} primaryLanguage{name}} contributions{totalCount}}}}}`;
  const u = (await gql(Q_USER, { login }, token).catch(e => { if (/NOT_FOUND/.test(e.message)) return {}; throw e })).user;
  if (!u) throw new Error(`GitHub user "${login}" not found. Organizations can't grow a tree: set the "username" input (or --user) to a personal account`);
  const now = new Date(), today = now.toISOString().slice(0, 10), days = new Map();
  // contributionsCollection spans at most one year per call, so walk year by year since the account was created
  for (let y = new Date(u.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1)), to = new Date(Math.min(Date.UTC(y + 1, 0, 1) - 1000, now.getTime()));
    const cc = (await gql(Q_CAL, { login, from: from.toISOString(), to: to.toISOString() }, token)).user.contributionsCollection;
    for (const w of cc.contributionCalendar.weeks) for (const d of w.contributionDays) if (d.date <= today) days.set(d.date, d.contributionCount);
  }
  const recent = (await gql(Q_RECENT, { login, from: new Date(now - 90 * DAY).toISOString(), to: now.toISOString() }, token)).user.contributionsCollection;
  // leaves are matched to your repos by name, so drop commits to other people's repos (e.g. someone else's "dotfiles")
  const own = recent.commitContributionsByRepository.filter(x => x.repository.owner.login.toLowerCase() === u.login.toLowerCase());
  return {
    login: u.login, createdAt: u.createdAt, fetchedAt: now.toISOString(),
    calendar: [...days].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, count]) => ({ date, count })),
    repos: u.repositories.nodes.map(r => ({ name: r.name, createdAt: r.createdAt, pushedAt: r.pushedAt, stars: r.stargazerCount, primary: r.primaryLanguage?.name || null, languages: r.languages.edges.map(e => ({ name: e.node.name, color: e.node.color || '#7a9a6a', bytes: e.size })) })),
    recentCommits: own.map(x => ({ repo: x.repository.name, lang: x.repository.primaryLanguage?.name || null, commits: x.contributions.totalCount })),
    mergedPRs: u.pullRequests.nodes.map(p => p.mergedAt).filter(Boolean)
  };
}

/* ---------------- derive metrics ---------------- */
function derive(d, asOf, exclude = EXCLUDE) {
  const A = asOf.toISOString().slice(0, 10), ex = new Set(exclude);
  const cal = d.calendar.filter(x => x.date <= A);
  const total = cal.reduce((s, x) => s + x.count, 0), activeDays = cal.filter(x => x.count > 0).length;
  const lastN = n => cal.slice(-n).reduce((s, x) => s + x.count, 0);
  let i = cal.length - 1, streak = 0; if (i >= 0 && cal[i].count === 0) i--; // today may still be empty, like GitHub's streak
  while (i >= 0 && cal[i].count > 0) { streak++; i-- }
  const days = cal.slice(-371).map(x => x.count); while (days.length < 371) days.unshift(0);
  const recentBy = {}; for (const c of d.recentCommits || []) recentBy[c.repo] = (recentBy[c.repo] || 0) + c.commits;
  const repos = d.repos.filter(r => r.createdAt.slice(0, 10) <= A).map(r => {
    const kept = r.languages.filter(l => !ex.has(l.name)).sort((a, b) => b.bytes - a.bytes);
    const main = r.primary && kept.some(l => l.name === r.primary) ? r.primary : kept[0]?.name || null;
    return { ...r, kept, main, col: main ? (kept.find(l => l.name === main)?.color || null) : null, recent: recentBy[r.name] || 0, bytes: kept.reduce((s, l) => s + l.bytes, 0) };
  }).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const L = new Map();
  for (const r of repos) for (const l of r.kept) { const e = L.get(l.name) || { name: l.name, color: l.color, bytes: 0, first: r.createdAt, repos: [] }; e.bytes += l.bytes; L.set(l.name, e) }
  for (const r of repos) if (r.main) L.get(r.main).repos.push(r);
  const totB = [...L.values()].reduce((s, l) => s + l.bytes, 0) || 1;
  let langs = [...L.values()].filter(l => l.repos.length > 0 || l.bytes / totB >= .04);
  const nR = langs.reduce((s, l) => s + l.repos.length, 0) || 1, sq = langs.reduce((s, l) => s + Math.sqrt(l.bytes), 0) || 1;
  langs.forEach(l => l.score = .5 * l.repos.length / nR + .5 * Math.sqrt(l.bytes) / sq); // half breadth (repos), half depth (code size)
  langs.sort((a, b) => b.score - a.score); langs = langs.slice(0, 6);
  if (!langs.length) langs = [{ name: 'Code', color: '#3fb950', bytes: 1, first: d.createdAt, repos: [], score: 1 }];
  const ss = langs.reduce((s, l) => s + l.score, 0); langs.forEach(l => l.share = l.score / ss);
  const names = new Set(langs.map(l => l.name));
  for (const r of repos) if (!r.main || !names.has(r.main)) { langs[0].repos.push(r); r.stray = true } // markup-only repos grow on the leader
  const mr = Math.max(1, ...repos.map(r => r.recent)); repos.forEach(r => r.act = r.recent / mr);
  langs.forEach(l => {
    l.repos.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
    const b = r => Math.sqrt(r.stray ? (r.bytes || r.languages.reduce((s, x) => s + x.bytes, 0) || 1) : (r.kept.find(k => k.name === l.name)?.bytes || 1));
    const mx = Math.max(1, ...l.repos.map(b)); l.repos.forEach(r => r.size = b(r) / mx);
    l.act = l.repos.length ? Math.max(...l.repos.map(r => r.act)) : 0;
  });
  const prs = (d.mergedPRs || []).filter(m => m.slice(0, 10) <= A && asOf - new Date(m) < 365 * DAY).length;
  const stars = repos.reduce((s, r) => s + (r.stars || 0), 0);
  return { total, activeDays, streak, days, last14: lastN(14), last30: lastN(30), last90: lastN(90), langs, prs, stars, repoCount: repos.length };
}

/* ---------------- season: continuous position from the real date ---------------- */
// 0 = spring equinox, 1 = summer solstice, 2 = autumn equinox, 3 = winter solstice (northern hemisphere)
function seasonPos(date) {
  const y = date.getUTCFullYear(), t = date.getTime();
  const a = [[y - 1, 11, 21, 3], [y, 2, 20, 4], [y, 5, 21, 5], [y, 8, 22, 6], [y, 11, 21, 7], [y + 1, 2, 20, 8]].map(([yy, m, dd, s]) => [Date.UTC(yy, m, dd), s]);
  for (let i = 0; i < a.length - 1; i++) if (t >= a[i][0] && t < a[i + 1][0]) return (a[i][1] + (t - a[i][0]) / (a[i + 1][0] - a[i][0])) % 4;
  return 0;
}
//          s     leaves autumn blossom snow
const KF = [[0, .25, 0, .9, 0], [.3, .6, 0, .6, 0], [.7, .95, 0, .1, 0], [1, 1, 0, 0, 0], [1.8, 1, .05, 0, 0], [2, 1, .2, 0, 0], [2.3, .92, .6, 0, 0], [2.6, .62, .95, 0, 0], [2.85, .32, 1, 0, .05],
  [3, .1, 1, 0, .3], [3.2, 0, 1, 0, .9], [3.7, 0, 1, 0, .8], [3.9, .1, 0, .35, .25], [4, .25, 0, .9, 0]];
function seasonState(s) {
  let k = 0; while (k < KF.length - 2 && KF[k + 1][0] <= s) k++;
  const [a, b] = [KF[k], KF[k + 1]], t = (s - a[0]) / ((b[0] - a[0]) || 1), v = i => lerp(a[i], b[i], clamp(t, 0, 1));
  const P = [ // sky top, sky bottom, ground, leaf green, far hills, haze
    ['#8ec9f0', '#f1f8ff', '#86c56a', '#79c25a', '#9cc3b7', '#e9f4f0'], ['#5aa9e6', '#d9efff', '#5fa346', '#2f8f3a', '#7fae9c', '#dcefff'],
    ['#e9a46f', '#fde3c3', '#b39a52', '#5f9a3a', '#c99b7a', '#fbe1c6'], ['#93a8bd', '#eef2f6', '#eef2f6', '#4d7a45', '#b9c4cf', '#eef2f6']];
  const u = ((s - .5) % 4 + 4) % 4, i0 = Math.floor(u), i1 = (i0 + 1) % 4, ft = u - i0, sm = ft * ft * (3 - 2 * ft);
  const p = P[i0].map((c, j) => mix(c, P[i1][j], sm));
  return { s, leaves: v(1), autumn: v(2), blossom: v(3), snow: v(4), skyTop: p[0], skyBot: p[1], ground: p[2], green: p[3], far: p[4], haze: p[5] };
}
const seasonName = s => ['spring', 'summer', 'autumn', 'winter'][Math.floor(((s % 4) + 4) % 4)];

/* ---------------- build tree geometry ---------------- */
function buildTree(m, login) {
  const segs = [], tips = [], limbs = [];
  const M = clamp(Math.log2(1 + m.total / 25) / 7, .22, 1); // maturity: 0.22 sapling … 1 full-grown (~3,200 contributions)
  const trunkH = 34 + 58 * M, trunkW = clamp(4 + 1.3 * Math.sqrt(m.activeDays), 4.5, 22);
  const R0 = rng(hash(login + ':trunk')), lean = (R0() - .5) * .06;
  const bx = W / 2, by = GY, tx = bx + Math.sin(lean) * trunkH, ty = by - trunkH;
  // limb plan: a language with more than 12 repos is split into sibling limbs, and every tree gets at least 3 limbs,
  // so a one-language or few-repo profile still grows a crown instead of a pole
  let plan = m.langs.map(l => ({ ...l, key: l.name, repos: [...l.repos] }));
  const split = p => { const i = plan.indexOf(p); plan.splice(i, 1, { ...p, key: p.key + '+a', repos: p.repos.filter((_, j) => j % 2 === 0), share: p.share * .55 }, { ...p, key: p.key + '+b', repos: p.repos.filter((_, j) => j % 2 === 1), share: p.share * .45 }) };
  for (let g = 0; g < 6 && plan.length < 6; g++) { const big = plan.filter(p => p.repos.length > 12).sort((a, b) => b.repos.length - a.repos.length)[0]; if (!big) break; split(big) }
  while (plan.length < 3) split([...plan].sort((a, b) => b.share - a.share)[0]);
  plan.sort((a, b) => b.share - a.share);
  const n = plan.length, step = n > 1 ? Math.min(.75, 2.1 / (n - 1)) : 0;
  const grow = (x, y, ang, len, wid, depth, li, act, col, r, d) => {
    const a = clamp(ang, -1.75, 1.75) * .98, bend = (r() - .5) * .3, x2 = x + Math.sin(a) * len, y2 = y - Math.cos(a) * len;
    segs.push({ x, y, x2, y2, cx: (x + x2) / 2 + Math.cos(a) * len * bend * .3, cy: (y + y2) / 2 + Math.sin(a) * len * bend * .3, w: wid, w2: wid * .7, li, d, a, rem: depth, act, col });
    if (depth <= 1) { tips.push({ x: x2, y: y2, li, a, act, col }); return }
    const kids = r() < .3 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const sp = kids === 2 ? (k ? 1 : -1) * (.32 + r() * .3) : (k - 1) * (.4 + r() * .2);
      grow(x2, y2, a + sp, len * (.64 + r() * .12), wid * .68, depth - 1, li, act, col, r, d + 1);
    }
  };
  plan.forEach((l, rank) => {
    const r = rng(hash(login + ':' + l.key)), k = rank === 0 ? 0 : Math.ceil(rank / 2) * (rank % 2 ? 1 : -1), out = k === 0 ? 1 : Math.sign(k);
    const ang = lean + k * step + (r() - .5) * .1, L = trunkH * (.55 + 1.05 * Math.sqrt(l.share)) * (.7 + .26 * M);
    const w0 = Math.max(2, trunkW * (.32 + .5 * Math.sqrt(l.share))), up = 1 - .14 * Math.abs(k) - r() * .04;
    let x = bx + (tx - bx) * up + Math.sign(k) * trunkW * .3 * up, y = by - trunkH * up;
    limbs.push({ li: rank, x, y });
    // repos are grouped oldest-first into at most 5 boughs along the limb; each repo is one twig fanning out of its bough
    const G = Math.min(5, l.repos.length), groups = Array.from({ length: G }, (_, g) => l.repos.slice(Math.floor(g * l.repos.length / G), Math.floor((g + 1) * l.repos.length / G)));
    const nodes = Math.max(2, G + 1), segL = L / nodes;
    for (let j = 0; j < nodes; j++) {
      const a = ang * (1 - .2 * j / nodes) + (r() - .5) * .14, wA = lerp(w0, w0 * .36, j / nodes), wB = lerp(w0, w0 * .36, (j + 1) / nodes);
      const x2 = x + Math.sin(a) * segL, y2 = y - Math.cos(a) * segL;
      segs.push({ x, y, x2, y2, cx: (x + x2) / 2, cy: (y + y2) / 2, w: wA, w2: wB, li: rank, d: 0, a, rem: 9, act: l.act, col: l.color });
      x = x2; y = y2;
      const grp = groups[j];
      if (grp && grp.length && j < nodes - 1) {
        const side = (j % 2 === 0 ? 1 : -1) * out, ra = clamp(a + side * (.62 + .25 * r()), -1.6, 1.6), big = Math.max(...grp.map(p => p.size));
        const rl = L * (.34 + .3 * big) * (1 - .18 * j / nodes), bw = Math.max(1.2, wB * .62), bx2 = x + Math.sin(ra) * rl * .55, by2 = y - Math.cos(ra) * rl * .55;
        segs.push({ x, y, x2: bx2, y2: by2, cx: (x + bx2) / 2 + Math.cos(ra) * rl * .04, cy: (y + by2) / 2 + Math.sin(ra) * rl * .04, w: bw, w2: bw * .75, li: rank, d: 1, a: ra, rem: 9, act: Math.max(...grp.map(p => p.act)), col: l.color });
        grp.forEach((rp, q) => {
          const fan = grp.length > 1 ? (q / (grp.length - 1) - .5) * Math.min(1.25, .42 * grp.length) : 0;
          const crowd = grp.length > 4; // many twigs on one bough: keep each one simple so the bough doesn't turn into a broom
          grow(bx2, by2, ra * .9 + fan, rl * (.28 + .3 * rp.size) * (crowd ? .8 : 1), bw * .7, crowd ? 1 : 1 + Math.round(1.6 * M * (.3 + .7 * rp.size)), rank, rp.act, rp.col || l.color, r, 2);
        });
      }
    }
    grow(x, y, ang * .8, segL * 1.15, Math.max(1, w0 * .34), 2 + Math.round(M), rank, l.act, l.color, r, 1); // crown at the limb tip
  });
  // fit: shrink around the base if the crown would leave the frame
  let minX = bx, maxX = bx, minY = by;
  for (const s of segs) { minX = Math.min(minX, s.x2 - 10); maxX = Math.max(maxX, s.x2 + 10); minY = Math.min(minY, s.y2 - 10) }
  const sc = Math.min(1, (W / 2 - 24) / Math.max(bx - minX, maxX - bx), (by - 14) / (by - minY));
  const T = (x, y) => [bx + (x - bx) * sc, by + (y - by) * sc];
  for (const s of segs) { [s.x, s.y] = T(s.x, s.y); [s.x2, s.y2] = T(s.x2, s.y2); [s.cx, s.cy] = T(s.cx, s.cy); s.w *= Math.sqrt(sc); s.w2 *= Math.sqrt(sc) }
  for (const t of tips) [t.x, t.y] = T(t.x, t.y);
  for (const l of limbs) [l.x, l.y] = T(l.x, l.y);
  const [ttx, tty] = T(tx, ty);
  return { segs, tips, limbs, plan, M, trunk: { bx, by, tx: ttx, ty: tty, w0: trunkW * Math.sqrt(sc), w1: trunkW * .7 * Math.sqrt(sc) } };
}

/* ---------------- render SVG ---------------- */
function segPath(s) {
  const nx = Math.cos(s.a), ny = Math.sin(s.a), a = s.w / 2, b = s.w2 / 2, c = (a + b) / 2;
  return `M${f1(s.x + nx * a)},${f1(s.y + ny * a)}Q${f1(s.cx + nx * c)},${f1(s.cy + ny * c)} ${f1(s.x2 + nx * b)},${f1(s.y2 + ny * b)}L${f1(s.x2 - nx * b)},${f1(s.y2 - ny * b)}Q${f1(s.cx - nx * c)},${f1(s.cy - ny * c)} ${f1(s.x - nx * a)},${f1(s.y - ny * a)}Z`;
}
const AUTUMN = ['#e8590c', '#f59f00', '#d9480f', '#c92a2a', '#f08c00', '#e67700'];
const GRASS = ['#c9bf95', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

function render(data, opts = {}) {
  const asOf = opts.asOf || new Date(), login = data.login || 'you';
  const m = derive(data, asOf, opts.exclude), S = seasonState(seasonPos(opts.seasonDate || asOf));
  const tree = buildTree(m, login), R = rng(hash(login + ':leaves'));
  const out = [], css = [], defs = [];
  const wind = m.last14 === 0 ? 0 : m.last14 < 10 ? 1 : 2, sunX = W - 110, sunY = 66;

  /* defs */
  defs.push(`<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${S.skyTop}"/><stop offset="1" stop-color="${S.skyBot}"/></linearGradient>`,
    `<radialGradient id="sun"><stop offset="0" stop-color="#fffbe8"/><stop offset=".25" stop-color="#ffe9a8" stop-opacity=".9"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="glow" cx="${sunX / W}" cy="${sunY / H}" r=".9"><stop offset="0" stop-color="#fff4cc" stop-opacity=".55"/><stop offset=".5" stop-color="#fff4cc" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="soil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(S.ground, '#5b4232', .4)}"/><stop offset="1" stop-color="${mix(S.ground, '#2e2118', .7)}"/></linearGradient>`,
    `<linearGradient id="bark" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3f2c20"/><stop offset=".55" stop-color="#6b4c38"/><stop offset=".8" stop-color="#8a6a52"/><stop offset="1" stop-color="#4a3426"/></linearGradient>`,
    `<radialGradient id="rayfade" gradientUnits="userSpaceOnUse" cx="${sunX}" cy="${sunY}" r="360"><stop offset="0" stop-color="#fff8dc" stop-opacity=".9"/><stop offset=".35" stop-color="#fff8dc" stop-opacity=".35"/><stop offset="1" stop-color="#fff8dc" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="shadow"><stop offset="0" stop-color="#1b140e" stop-opacity=".32"/><stop offset="1" stop-color="#1b140e" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="fruit" cx=".35" cy=".35" r=".7"><stop offset="0" stop-color="#ff8a80"/><stop offset=".6" stop-color="#e03131"/><stop offset="1" stop-color="#a51111"/></radialGradient>`,
    `<path id="l" d="M0,-4C2.4,-2 2.4,2 0,4C-2.4,2 -2.4,-2 0,-4Z"/><path id="s" d="M0,-3.2C1.9,-1.6 1.9,1.6 0,3.2C-1.9,1.6 -1.9,-1.6 0,-3.2Z"/>`,
    `<g id="bl">${[0, 72, 144, 216, 288].map(a => `<ellipse cx="0" cy="-2.1" rx="1.6" ry="2.2" transform="rotate(${a})" fill="#fbd3e4"/>`).join('')}<circle r="1.1" fill="#f7b267"/></g>`,
    `<g id="fr"><path d="M0,-3.4Q.6,-6 2.4,-7" stroke="#5b4232" stroke-width=".8" fill="none"/><path d="M1.2,-5.6q2.6,-1.6 3.6,.2q-2.4,1 -3.6,-.2z" fill="#4f8a3a"/><circle r="3.4" fill="url(#fruit)"/><ellipse cx="-1.1" cy="-1.2" rx="1" ry=".7" fill="#fff" opacity=".55"/></g>`,
    `<clipPath id="frame"><rect width="${W}" height="${H}" rx="16"/></clipPath>`);

  /* sky, sun, rays, clouds */
  const sunGlow = .3 + .6 * Math.min(1, m.streak / 14);
  out.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#glow)" opacity="${f1(sunGlow)}"/>`);
  const rays = Array.from({ length: 14 }, (_, i) => { const a = i / 14 * Math.PI * 2, b = a + .045; return `M${sunX},${sunY}L${f1(sunX + Math.cos(a) * 420)},${f1(sunY + Math.sin(a) * 420)}L${f1(sunX + Math.cos(b) * 420)},${f1(sunY + Math.sin(b) * 420)}Z` }).join('');
  out.push(`<g class="rays" style="transform-origin:${sunX}px ${sunY}px" opacity="${f1((.18 + .22 * sunGlow) * (1 - .5 * S.snow))}"><path d="${rays}" fill="url(#rayfade)"/></g>`);
  css.push(`.rays{animation:spin 240s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`);
  out.push(`<circle cx="${sunX}" cy="${sunY}" r="${f1(40 + 34 * sunGlow)}" fill="url(#sun)" opacity="${f1(sunGlow)}"/><circle cx="${sunX}" cy="${sunY}" r="15" fill="#fff6d6" opacity="${f1(.6 + .4 * sunGlow)}"/>`);
  const cloud = (x, y, s, o) => `<g transform="translate(${x},${y}) scale(${s})" opacity="${o}"><path d="M-40,8Q-44,-6 -28,-8Q-26,-24 -8,-20Q2,-34 18,-22Q36,-26 38,-8Q50,-4 44,8Z" fill="#fff"/><path d="M-40,8Q0,13 44,8Q30,2 0,5Q-24,3 -40,8Z" fill="#000" opacity=".05"/></g>`;
  out.push(`<g class="drift">${cloud(150, 62, 1, .85)}${cloud(W - 330, 40, .7, .7)}${cloud(380, 92, .5, .55)}</g>`);
  if (m.streak === 0) out.push(cloud(sunX + 6, sunY + 10, 1.15, .96));
  css.push(`.drift{animation:drift 80s ease-in-out infinite alternate}@keyframes drift{from{transform:translateX(-35px)}to{transform:translateX(45px)}}`);

  /* layered hills with a few distant trees */
  const hillFn = (seed, base, amp) => { const r = rng(hash(login + seed)), ph = r() * 6, f = 1.4 + r() * 1.2; return x => base - amp * (.55 + .45 * Math.sin(x / W * Math.PI * f + ph)) * (.85 + .15 * Math.sin(x * .029 + ph * 2)) };
  const hillPath = (fn, col) => { let d = `M0,${GY}`; for (let x = 0; x <= W; x += 20) d += `L${x},${f1(fn(x))}`; return `<path d="${d}L${W},${GY}Z" fill="${col}"/>` };
  const h0 = hillFn(':h0', GY - 30, 95), h1 = hillFn(':h1', GY - 6, 62), h2 = hillFn(':h2', GY + 2, 34);
  out.push(hillPath(h0, mix(S.far, S.haze, .45)), hillPath(h1, mix(mix(S.ground, '#5d8a63', .25), S.haze, .5)));
  const RT = rng(hash(login + ':distant')), dtc = S.leaves > .3 ? (S.autumn > .5 ? mix('#c4772f', S.haze, .45) : mix(S.green, S.haze, .45)) : mix('#7a6a5c', S.haze, .5);
  for (let k = 0; k < 11; k++) { const x = RT() * W; if (Math.abs(x - W / 2) < 170) continue; const y = h1(x) + 2, s = .7 + RT() * .6; out.push(`<path d="M${f1(x)},${f1(y)}v-${f1(7 * s)}" stroke="${mix('#5b4232', S.haze, .5)}" stroke-width="1.2"/>${S.leaves > .3 ? `<ellipse cx="${f1(x)}" cy="${f1(y - 10 * s)}" rx="${f1(5 * s)}" ry="${f1(6.5 * s)}" fill="${dtc}"/>` : `<path d="M${f1(x)},${f1(y - 5 * s)}l-3,-5M${f1(x)},${f1(y - 6 * s)}l3,-5" stroke="${dtc}" stroke-width=".8"/>`}`) }
  out.push(hillPath(h2, mix(mix(S.ground, '#4f7a4f', .15), S.haze, .25)));

  /* ground + soft tree shadow */
  out.push(`<rect y="${GY}" width="${W}" height="${H - GY}" fill="url(#soil)"/><rect y="${GY - 2}" width="${W}" height="4" fill="${S.ground}"/>`);
  if (S.snow > .1) out.push(`<path d="M0,${GY - 2}H${W}V${GY + 9}Q${W * .75},${GY + 13} ${W / 2},${GY + 8}T0,${GY + 10}Z" fill="#f8fbff" opacity="${f1(Math.min(1, S.snow * 1.1))}"/>`);
  let cMinX = W, cMaxX = 0, cMinY = H; for (const t of tree.tips) { cMinX = Math.min(cMinX, t.x); cMaxX = Math.max(cMaxX, t.x); cMinY = Math.min(cMinY, t.y) }
  if (!tree.tips.length) { cMinX = W / 2 - 20; cMaxX = W / 2 + 20; cMinY = GY - 60 }
  out.push(`<ellipse cx="${f1(W / 2 + 18)}" cy="${GY + 3}" rx="${f1((cMaxX - cMinX) / 2 + 26)}" ry="9" fill="url(#shadow)"/>`);

  /* trunk with root flares */
  const t = tree.trunk, mx = (t.bx + t.tx) / 2, my = (GY + t.ty) / 2, a0 = t.w0 / 2, a1 = t.w1 / 2;
  out.push(`<path d="M${f1(t.bx - a0 - 9)},${GY + 1}Q${f1(t.bx - a0 - 1)},${GY - 2} ${f1(t.bx - a0)},${GY - 13}Q${f1(mx - a0 * .85)},${f1(my)} ${f1(t.tx - a1)},${f1(t.ty)}L${f1(t.tx + a1)},${f1(t.ty)}Q${f1(mx + a0 * .85)},${f1(my)} ${f1(t.bx + a0)},${GY - 13}Q${f1(t.bx + a0 + 1)},${GY - 2} ${f1(t.bx + a0 + 11)},${GY + 1}Z" fill="url(#bark)"/>`);
  const RK = rng(hash(login + ':bark'));
  for (let k = 0; k < 4; k++) { const ox = (RK() - .5) * a0 * 1.1, y1 = GY - 10 - RK() * (GY - t.ty) * .3, y2 = y1 - 12 - RK() * (GY - t.ty) * .4; out.push(`<path d="M${f1(t.bx + ox)},${f1(y1)}q${f1((RK() - .5) * 3)},${f1((y2 - y1) / 2)} ${f1((RK() - .5) * 2)},${f1(y2 - y1)}" stroke="#2f2018" stroke-width=".8" fill="none" opacity=".45"/>`) }

  /* leaves: back layer behind the branches, front layer in front, lit from the sun side */
  const vib = .6 + .4 * Math.min(1, m.last30 / 30);
  const anchors = [...tree.tips.map(tp => ({ ...tp, w: 1, rad: 10.5 })), ...tree.segs.filter(s => s.rem === 1 && s.d >= 2).map(s => ({ x: (s.x + s.x2) / 2, y: (s.y + s.y2) / 2, li: s.li, a: s.a, act: s.act, col: s.col, w: .5, rad: 8 }))];
  const want = anchors.map(an => 11 * an.w * (.45 + .55 * Math.sqrt(an.act || 0)) * vib * S.leaves);
  const wsum = want.reduce((s, x) => s + x, 0), cap = wsum > 1400 ? 1400 / wsum : 1;
  const ccx = (cMinX + cMaxX) / 2, ccy = (cMinY + t.ty) / 2, cw = Math.max(40, cMaxX - cMinX) / 2, ch = Math.max(30, t.ty - cMinY) / 2;
  const swayAmp = [.35, .8, 1.3][wind];
  tree.plan.forEach((l, li) => {
    const lb = tree.limbs.find(q => q.li === li), r = rng(hash(login + ':sway' + l.key)), back = [], wood = [], front = [];
    for (const s of tree.segs) if (s.li === li) wood.push(`<path d="${segPath(s)}" fill="${s.d === 0 ? '#5b4232' : mix('#5b4232', '#7a5a44', Math.min(1, s.d * .25))}"/>`);
    for (const s of tree.segs) if (s.li === li && s.w > 2.6 && s.d === 0) { const nx = Math.cos(s.a), ny = Math.sin(s.a), o = s.w * .22; wood.push(`<path d="M${f1(s.x + nx * o)},${f1(s.y + ny * o)}Q${f1(s.cx + nx * o)},${f1(s.cy + ny * o)} ${f1(s.x2 + nx * o * .7)},${f1(s.y2 + ny * o * .7)}" stroke="#8a6a52" stroke-width="${f1(s.w * .18)}" fill="none" stroke-linecap="round" opacity=".55"/>`) }
    if (S.snow > .15) for (const s of tree.segs) if (s.li === li && Math.abs(s.a) > .35) {
      const sg = Math.sin(s.a) > 0 ? -1 : 1, nx = Math.cos(s.a) * sg, ny = Math.sin(s.a) * sg, o = s.w * .45;
      wood.push(`<path d="M${f1(s.x + nx * o)},${f1(s.y + ny * o)}Q${f1(s.cx + nx * o)},${f1(s.cy + ny * o)} ${f1(s.x2 + nx * o * .7)},${f1(s.y2 + ny * o * .7)}" stroke="#fff" stroke-width="${f1(Math.min(2.6, 1 + s.w * .35) * S.snow)}" stroke-linecap="round" fill="none"/>`);
    }
    anchors.forEach((an, ai) => {
      if (an.li !== li) return;
      const n = want[ai] > .05 ? Math.round(want[ai] * cap + R() * .6) : 0;
      for (let k = 0; k < n; k++) {
        const ang = R() * Math.PI * 2, rad = 1.5 + R() * an.rad, x = an.x + Math.cos(ang) * rad + Math.sin(an.a) * 2, y = an.y + Math.sin(ang) * rad * .8 - 1.5;
        const base = R() < S.autumn ? AUTUMN[Math.floor(R() * AUTUMN.length)] : mix(S.green, '#a3d977', R() * .35);
        const lit = clamp(.5 + .32 * (x - ccx) / cw + .32 * (ccy - y) / ch, 0, 1), isBack = R() < .42;
        let c = mix(base, an.col || l.color, lerp(.34, .24, S.autumn));
        c = isBack ? mix(c, '#14200f', .28 + .15 * (1 - lit)) : mix(mix(c, '#14200f', .14 * (1 - lit)), '#fffbe6', .16 * lit);
        (isBack ? back : front).push(`<use href="#${R() < .35 ? 's' : 'l'}" transform="translate(${Math.round(x)} ${Math.round(y)})rotate(${Math.round(R() * 180)})" fill="${c}"/>`);
      }
    });
    if (S.leaves < .35) for (const tp of tree.tips) if (tp.li === li) front.push(`<circle cx="${f1(tp.x)}" cy="${f1(tp.y)}" r="1.9" fill="${mix(tp.col || l.color, '#ffffff', .1)}" stroke="${mix(tp.col || l.color, '#000000', .4)}" stroke-width=".5"/>`);
    const dur = (6 + r() * 3).toFixed(1), del = (-r() * 6).toFixed(1);
    out.push(`<g class="limb" style="transform-origin:${f1(lb.x)}px ${f1(lb.y)}px;animation-duration:${dur}s;animation-delay:${del}s">${back.join('')}${wood.join('')}${front.join('')}</g>`);
  });
  css.push(`@keyframes sway{from{transform:rotate(-${swayAmp}deg)}to{transform:rotate(${swayAmp}deg)}}.limb{animation:sway 7s ease-in-out infinite alternate}`);

  /* blossoms (spring) and fruit (summer into autumn): pull requests merged in the last year */
  const RF = rng(hash(login + ':fruit')), pick = () => tree.tips[Math.floor(RF() * tree.tips.length)];
  if (tree.tips.length) {
    const nB = Math.round(clamp(10 + 4 * Math.sqrt(m.prs), 10, 50) * S.blossom);
    for (let k = 0; k < nB; k++) { const tp = pick(); out.push(`<use href="#bl" transform="translate(${f1(tp.x + (RF() - .5) * 12)} ${f1(tp.y + (RF() - .5) * 9)})rotate(${Math.round(RF() * 72)})scale(${f1(.75 + RF() * .45)})"/>`) }
    if (S.leaves > .35 && S.blossom < .2) for (let k = 0; k < Math.round(Math.min(16, 2 * Math.sqrt(m.prs))); k++) { const tp = pick(); out.push(`<use href="#fr" transform="translate(${f1(tp.x + (RF() - .5) * 8)} ${f1(tp.y + 5 + RF() * 3)})scale(${f1(.62 + RF() * .18)})"/>`) }
  }

  /* birds: stars */
  const nBirds = [1, 10, 50, 200].filter(v => m.stars >= v).length, RB = rng(hash(login + ':birds'));
  const perches = tree.segs.filter(s => s.d >= 1 && s.d <= 2 && Math.abs(s.a) > .5 && Math.abs(s.a) < 1.4);
  for (let k = 0; k < nBirds && perches.length; k++) {
    const s = perches[Math.floor(RB() * perches.length)], x = lerp(s.x, s.x2, .55), y = lerp(s.y, s.y2, .55) - s.w * .5 - 3, fl = s.a > 0 ? -1 : 1;
    out.push(`<g transform="translate(${f1(x)},${f1(y)}) scale(${fl},1)"><g class="bob"><ellipse cx="0" cy="0" rx="4.2" ry="2.8" fill="#3d3530"/><ellipse cx="1" cy=".6" rx="2.6" ry="1.6" fill="#c2410c" opacity=".85"/><circle cx="3.2" cy="-2.4" r="1.9" fill="#3d3530"/><circle cx="3.8" cy="-2.8" r=".45" fill="#fff"/><path d="M4.9,-2.5l2,.6l-2,.5z" fill="#f59f00"/><path d="M-3.6,-.4l-3.4,-1.6l.6,2.4z" fill="#3d3530"/></g></g>`);
  }
  css.push(`.bob{animation:bob 2.6s ease-in-out infinite}@keyframes bob{0%,80%,100%{transform:none}88%{transform:translateY(-1.2px) rotate(-6deg)}}`);

  /* drifting things: autumn leaves, spring petals, winter snow, summer pollen */
  const RD = rng(hash(login + ':fall')), fall = [];
  const kind = S.snow > .3 ? 'snow' : S.blossom > .35 ? 'petal' : (S.autumn > .35 && S.leaves > .05) ? 'leaf' : 'mote';
  const nF = { snow: 40, leaf: Math.round(10 + 14 * S.autumn), petal: 14, mote: 16 }[kind];
  for (let k = 0; k < nF && tree.tips.length; k++) {
    const tp = tree.tips[Math.floor(RD() * tree.tips.length)];
    const x0 = kind === 'snow' ? RD() * W : kind === 'mote' ? 60 + RD() * (W - 120) : tp.x, y0 = kind === 'snow' ? -10 - RD() * 30 : kind === 'mote' ? 140 + RD() * 150 : tp.y;
    const dx = Math.round((RD() - .3) * (kind === 'snow' ? 40 : 90)), dy = kind === 'mote' ? -Math.round(40 + RD() * 60) : Math.round(GY - y0 + 2);
    const dur = (kind === 'snow' ? 9 + RD() * 7 : kind === 'mote' ? 10 + RD() * 8 : 6 + RD() * 6).toFixed(1), del = (-RD() * 14).toFixed(1);
    css.push(`@keyframes f${k}{0%{transform:translate(0,0) rotate(0);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translate(${dx}px,${dy}px) rotate(${kind === 'leaf' || kind === 'petal' ? 540 : 0}deg);opacity:0}}`);
    const shape = kind === 'snow' ? `<circle r="${f1(1 + RD() * 1.4)}" fill="#fff"/>` : kind === 'mote' ? `<circle r="1.1" fill="#fffbe0" opacity=".8"/>` : kind === 'petal' ? `<ellipse rx="2.4" ry="1.4" fill="#f7c4da"/>` : `<use href="#l" fill="${mix(AUTUMN[Math.floor(RD() * AUTUMN.length)], tp.col || tree.plan[tp.li].color, .25)}"/>`;
    fall.push(`<g transform="translate(${f1(x0)},${f1(y0)})"><g style="animation:f${k} ${dur}s linear ${del}s infinite">${shape}</g></g>`);
  }
  out.push(...fall);

  /* grass: the last 371 days, one blade per day */
  const nzs = m.days.filter(v => v > 0).sort((a, b) => a - b), ref = Math.max(4, nzs[Math.floor(nzs.length * .9)] || 4);
  const q = v => v === 0 ? 0 : 1 + Math.min(3, Math.floor(4 * Math.min(1, v / ref) - 1e-9)), RG = rng(hash(login + ':grass')), gx0 = 20, gstep = (W - 40) / 371, bins = {};
  m.days.forEach((v, i) => { for (let b = 0; b < (v ? 3 : 2); b++) {
    const h = v === 0 ? 3 + RG() * 4 : (7 + 24 * Math.sqrt(Math.min(1, v / ref))) * (b === 0 ? 1 : .55 + RG() * .3), x = gx0 + i * gstep + RG() * gstep * .6, tilt = v ? (b - 1) * 4 + (RG() - .5) * 2 : (RG() - .5) * 3, key = q(v) + '_' + (i % 3);
    (bins[key] ||= []).push(`M${f1(x)},${GY + 1}q${f1(tilt * .3)},${f1(-h / 2)} ${f1(tilt)},${f1(-h)}`);
  } });
  for (const [key, paths] of Object.entries(bins)) { const [lv, cls] = key.split('_'); out.push(`<path class="g${cls}" d="${paths.join('')}" stroke="${mix(lv === '0' ? mix(mix(GRASS[0], S.green, .25), S.ground, .3) : GRASS[lv], '#ffffff', S.snow * .55)}" stroke-width="${lv === '0' ? 1.2 : 1.7}" stroke-linecap="round" fill="none"/>`) }
  css.push(`.g0,.g1,.g2{transform-origin:0 ${GY}px}@keyframes gs{from{transform:skewX(-${2 + wind * 2}deg)}to{transform:skewX(${2 + wind * 2}deg)}}.g0{animation:gs 3.1s ease-in-out infinite alternate}.g1{animation:gs 3.7s ease-in-out -1s infinite alternate}.g2{animation:gs 4.3s ease-in-out -2s infinite alternate}`);

  css.push(`@media (prefers-reduced-motion:reduce){*{animation:none!important}}`);
  const label = `${login}'s GitTree: ${m.total.toLocaleString('en-US')} contributions, ${m.langs.map(l => l.name).join(', ')}; ${seasonName(S.s)}.`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><style>${css.join('')}</style><defs>${defs.join('')}</defs><g clip-path="url(#frame)">${out.join('')}</g></svg>`,
    metrics: { total: m.total, activeDays: m.activeDays, streak: m.streak, prs: m.prs, stars: m.stars, repos: m.repoCount, maturity: +tree.M.toFixed(2), trunkGirth: +tree.trunk.w0.toFixed(1), season: seasonName(S.s), seasonPos: +S.s.toFixed(3), limbs: m.langs.map(l => `${l.name} (${l.repos.length} repos, ${(l.share * 100).toFixed(0)}%)`), leaves: (out.join('').match(/href="#[ls]"/g) || []).length }
  };
}

/* ---------------- main ---------------- */
async function main() {
  const argv = process.argv.slice(2), opt = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2), v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt[k] = v; i++ } else opt[k] = true }
  let data;
  if (opt.data) data = JSON.parse(readFileSync(opt.data, 'utf8'));
  else {
    const user = opt.user || process.env.GITHUB_REPOSITORY_OWNER, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!user) throw new Error('Pass --user <login> (or run inside GitHub Actions)');
    if (!token) throw new Error('Set GITHUB_TOKEN so the script can read your public activity');
    data = await fetchData(user, token);
  }
  if (opt['save-data']) { mkdirSync(dirname(opt['save-data']), { recursive: true }); writeFileSync(opt['save-data'], JSON.stringify(data)) }
  // pinned to noon UTC of the day, so repeated runs on the same day produce the same image unless the data changed
  const day = (flag, v) => { const d = new Date(v + 'T12:00:00Z'); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(d) || d.toISOString().slice(0, 10) !== v) throw new Error(`--${flag} must be a date like 2026-05-01, got "${v}"`); return d };
  const asOf = day('date', typeof opt.date === 'string' ? opt.date : new Date().toISOString().slice(0, 10));
  const seasonDate = typeof opt['season-date'] === 'string' ? day('season-date', opt['season-date']) : undefined;
  // "none" (or a bare --exclude) lets every language grow a limb
  const exclude = typeof opt.exclude === 'string' && opt.exclude.trim().toLowerCase() !== 'none' ? opt.exclude.split(',').map(s => s.trim()).filter(Boolean) : opt.exclude ? [] : undefined;
  const { svg, metrics } = render(data, { asOf, seasonDate, exclude });
  const outPath = opt.out || 'assets/tree.svg';
  mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, svg);
  console.log(`Wrote ${outPath} (${(svg.length / 1024).toFixed(1)} KB)`, JSON.stringify(metrics));
}
const isMain = typeof process !== 'undefined' && process.argv[1] && (import.meta.url === new URL(process.argv[1], 'file://').href || process.argv[1].endsWith('tree.mjs'));
if (isMain) main().catch(e => { console.error(e.message); process.exit(1) });
export { render, derive, seasonPos, fetchData };
