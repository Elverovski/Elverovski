// Builds stats-dark.svg / stats-light.svg for the profile README.
// Runs daily in GitHub Actions (see ../workflows/snake.yml). No dependencies.
// Usage: node .github/scripts/stats.mjs <outDir> [user]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'dist';
const USER = process.argv[3] ?? process.env.GITHUB_REPOSITORY_OWNER ?? 'Elverovski';
const TOKEN = process.env.GITHUB_TOKEN;

const THEMES = {
  dark: { bg: '#0d1117', surface: '#161b22', border: '#30363d', fg: '#e6edf3', muted: '#8b949e', accent: '#22c55e',
    shades: ['#f0f6fc', '#b1bac4', '#8b949e', '#6e7681', '#484f58', '#30363d'] },
  light: { bg: '#ffffff', surface: '#f6f8fa', border: '#d0d7de', fg: '#1f2328', muted: '#59636e', accent: '#16a34a',
    shades: ['#1f2328', '#424a53', '#6e7781', '#8c959f', '#afb8c1', '#d0d7de'] },
};
const SANS = "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
// Generated / config files that would skew the language mix.
const IGNORED_LANGS = new Set(['ShaderLab', 'HLSL', 'GLSL', 'Batchfile', 'Makefile', 'Dockerfile', 'Procfile', 'Mathematica']);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const headers = { 'User-Agent': 'profile-stats', Accept: 'application/vnd.github+json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** Contribution days as [{date, count}], oldest first. GraphQL when a token exists, else the public calendar page. */
async function contributionDays() {
  if (TOKEN) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `query($u:String!){user(login:$u){contributionsCollection{contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`, variables: { u: USER } }),
      });
      const json = await res.json();
      const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
      if (weeks) return weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
      console.warn('GraphQL returned no calendar, falling back to HTML:', JSON.stringify(json?.errors ?? json).slice(0, 200));
    } catch (e) {
      console.warn('GraphQL failed, falling back to HTML:', e.message);
    }
  }
  const html = await (await fetch(`https://github.com/users/${USER}/contributions`, { headers: { 'User-Agent': 'profile-stats' } })).text();
  const idToDate = {};
  for (const m of html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*?id="([^"]+)"|id="([^"]+)"[^>]*?data-date="(\d{4}-\d{2}-\d{2})"/g)) {
    idToDate[m[2] ?? m[3]] = m[1] ?? m[4];
  }
  const days = [];
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const date = idToDate[m[1]];
    if (!date) continue;
    const n = m[2].match(/^(\d[\d,]*) contribution/);
    days.push({ date, count: n ? Number(n[1].replace(/,/g, '')) : 0 });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function streaks(days) {
  let best = 0, run = 0;
  for (const d of days) { run = d.count > 0 ? run + 1 : 0; best = Math.max(best, run); }
  // Current streak: today may still be empty, so start from yesterday in that case.
  let i = days.length - 1, current = 0;
  if (i >= 0 && days[i].count === 0) i--;
  for (; i >= 0 && days[i].count > 0; i--) current++;
  return { current, best };
}

async function collect() {
  const user = await api(`/users/${USER}`);
  const repos = (await api(`/users/${USER}/repos?per_page=100&type=owner`)).filter((r) => !r.fork && !r.archived);
  const stars = repos.reduce((a, r) => a + r.stargazers_count, 0);
  // Every repo has the same weight: its language shares add up to 1.
  const weight = {};
  await Promise.all(repos.map(async (r) => {
    const langs = Object.entries(await api(`/repos/${r.full_name}/languages`)).filter(([l]) => !IGNORED_LANGS.has(l));
    const total = langs.reduce((a, [, b]) => a + b, 0);
    for (const [l, b] of langs) if (total) weight[l] = (weight[l] ?? 0) + b / total;
  }));
  const sum = Object.values(weight).reduce((a, b) => a + b, 0) || 1;
  let langs = Object.entries(weight).sort((a, b) => b[1] - a[1]).map(([name, w]) => ({ name, pct: (w / sum) * 100 }));
  if (langs.length > 6) {
    const rest = langs.slice(5).reduce((a, l) => a + l.pct, 0);
    langs = [...langs.slice(0, 5), { name: 'Other', pct: rest }];
  }
  const days = await contributionDays();
  const total = days.reduce((a, d) => a + d.count, 0);
  return { repos: repos.length, stars, followers: user.followers, total, ...streaks(days), langs, hasDays: days.length > 0 };
}

function render(t, s) {
  const W = 1000, H = 236, P = 28;
  const fmt = (n) => n.toLocaleString('en-US');
  const tiles = [
    { v: s.hasDays ? fmt(s.total) : '—', l: 'CONTRIBUTIONS · 1 YEAR' },
    { v: s.hasDays ? `${s.current}d` : '—', l: 'CURRENT STREAK', live: s.current > 0 },
    { v: s.hasDays ? `${s.best}d` : '—', l: 'LONGEST STREAK' },
    { v: fmt(s.repos), l: 'PUBLIC REPOS' },
  ];
  const tw = (W - P * 2) / tiles.length;
  const tileSvg = tiles.map((tile, i) => {
    const x = P + i * tw;
    return `<g class="rise" style="animation-delay:${(0.1 + i * 0.08).toFixed(2)}s">
    ${i ? `<line x1="${x - 0.5}" y1="${P + 4}" x2="${x - 0.5}" y2="${P + 70}" stroke="${t.border}"/>` : ''}
    <text x="${x + (i ? 24 : 0)}" y="${P + 36}" font-family="${SANS}" font-size="34" font-weight="700" letter-spacing="-1" fill="${t.fg}">${esc(tile.v)}</text>
    ${tile.live ? `<circle cx="${x + (i ? 24 : 0) + 6}" cy="${P + 59}" r="4" fill="${t.accent}"><animate attributeName="opacity" values="1;.3;1" dur="1.6s" repeatCount="indefinite"/></circle>` : ''}
    <text x="${x + (i ? 24 : 0) + (tile.live ? 16 : 0)}" y="${P + 63}" font-family="${MONO}" font-size="11" letter-spacing="1.5" fill="${t.muted}">${tile.l}</text>
  </g>`;
  }).join('\n  ');

  const barY = 150, barW = W - P * 2;
  let x = P;
  const segs = s.langs.map((l, i) => {
    const w = (l.pct / 100) * barW;
    const seg = `<rect x="${x.toFixed(2)}" y="${barY}" width="${Math.max(w - 2, 1).toFixed(2)}" height="10" fill="${t.shades[i]}"/>`;
    x += w;
    return seg;
  }).join('');
  let lx = P;
  const legend = s.langs.map((l, i) => {
    const label = `${l.name} ${l.pct.toFixed(1)}%`;
    const out = `<g class="rise" style="animation-delay:${(0.9 + i * 0.06).toFixed(2)}s"><rect x="${lx}" y="${barY + 30}" width="10" height="10" rx="2" fill="${t.shades[i]}" stroke="${t.border}"/>
    <text x="${lx + 16}" y="${barY + 39}">${esc(label)}</text></g>`;
    lx += 16 + label.length * 7.3 + 26;
    return out;
  }).join('\n    ');
  const updated = new Date().toISOString().slice(0, 10);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub stats">
<title>GitHub stats: ${s.total} contributions in the last year, current streak ${s.current} days, longest streak ${s.best} days, ${s.repos} public repos. Languages: ${s.langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}.</title>
<style>@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}.rise{animation:rise .8s cubic-bezier(.2,.7,.2,1) both}</style>
<defs><clipPath id="bar"><rect x="${P}" y="${barY}" height="10" width="0" rx="5"><animate attributeName="width" from="0" to="${barW}" dur="1.4s" begin=".5s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .7 .2 1"/></rect></clipPath></defs>
<rect x=".75" y=".75" width="${W - 1.5}" height="${H - 1.5}" rx="12" fill="${t.surface}" stroke="${t.border}" stroke-width="1.5"/>
  ${tileSvg}
<text x="${P}" y="${barY - 16}" font-family="${MONO}" font-size="11" letter-spacing="1.5" fill="${t.muted}">MOST USED LANGUAGES · PUBLIC REPOS</text>
<text x="${W - P}" y="${barY - 16}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${t.muted}">updated ${updated}</text>
<rect x="${P}" y="${barY}" width="${barW}" height="10" rx="5" fill="${t.bg}"/>
<g clip-path="url(#bar)">${segs}</g>
<g font-family="${MONO}" font-size="12" fill="${t.fg}">
    ${legend}
</g>
</svg>
`;
}

const stats = await collect();
console.log(JSON.stringify(stats));
mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) writeFileSync(join(OUT, `stats-${name}.svg`), render(t, stats));
console.log(`Wrote stats SVGs to ${OUT}`);
