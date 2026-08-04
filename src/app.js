// OpenSourceGraph — dashboard front-end. Vanilla JS, no dependencies.
// Reads the baked static JSON in ./data/ and renders everything with inline SVG.

const DATA = './data';
const DATA_VERSION = '20260726-4';
const cache = new Map();
const dynamicPackages = new Map();
const state = { index: null, compareMode: false, selected: null, compareSel: [null, null] };

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDownloads = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(0)}k`;
  return String(x);
};

// Risk band → color. Higher score = more reason to look closer.
function bandColor(band) {
  return { Low: 'var(--green)', Moderate: 'var(--gold)', Elevated: 'var(--amber)', High: 'var(--red)', Unavailable: 'var(--t2)' }[band] || 'var(--t2)';
}
function bandBg(band) {
  return {
    Low: 'rgba(0,229,160,.10)', Moderate: 'rgba(245,197,24,.12)',
    Elevated: 'rgba(255,180,84,.12)', High: 'rgba(255,107,107,.12)',
  }[band] || 'var(--s2)';
}

async function fetchJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const json = await res.json();
  cache.set(url, json);
  return json;
}
const loadPackage = (slug) => dynamicPackages.has(slug)
  ? Promise.resolve(dynamicPackages.get(slug))
  : fetchJSON(`${DATA}/packages/${slug}.json?v=${DATA_VERSION}`);

// ---------------------------------------------------------------------------
// Live lookup — scoring engine, ported 1:1 from scripts/lib/analyze.mjs (the
// same module the offline ingest uses to bake data/packages/*.json) so a
// client-side lookup scores identically to the curated snapshots.
//
// Sources used here were verified for browser CORS with real headless-Chrome
// fetches from a localhost page (not just curl):
//   deps.dev (package/version/project + :dependencies) — access-control-allow-origin: *
//   OSV.dev (POST /v1/query)                            — reflects Origin
//   ecosyste.ms (npmjs.org + pypi.org registries)        — access-control-allow-origin: *
//   npm registry + npm downloads API                     — access-control-allow-origin: *
//   pypi.org JSON API                                    — access-control-allow-origin: *
//   GitHub REST (repo + contributors)                    — access-control-allow-origin: *
// pypistats.org (the ingest's PyPI download fallback) does NOT allow browser
// CORS (fetch throws "Failed to fetch", no ACAO header even outside its own
// rate limit) — it is skipped client-side. PyPI download counts fall back to
// ecosyste.ms's aggregated figure, or read Unavailable, exactly like any
// other missing source degrades the affected sub-signal's confidence rather
// than being invented.
// ---------------------------------------------------------------------------
const LIVE_TIMEOUT_MS = 9000; // per-fetch budget for the primary lookup
const DEP_TIMEOUT_MS = 6000; // per-fetch budget inside the dependency rollup (many small calls)
const DEP_BUDGET_MS = 22000; // wall-clock budget for the whole dependency rollup
const DEP_POOL_SIZE = 4;
const DEP_MAX = 8;
const liveCache = new Map();

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round(n, places = 0) { const f = 10 ** places; return Math.round(n * f) / f; }

const PERMISSIVE = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Apache-1.1',
  '0BSD', 'Unlicense', 'Zlib', 'BSL-1.0', 'MIT-0', 'CC0-1.0', 'WTFPL', 'PSF-2.0',
  'Python-2.0',
]);
const WEAK_COPYLEFT = new Set([
  'MPL-2.0', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0',
  'LGPL-3.0-only', 'LGPL-3.0-or-later', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0',
]);
const STRONG_COPYLEFT = new Set([
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only',
  'GPL-3.0-or-later', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
]);
function classifyLicense(spdxId) {
  const id = (spdxId || '').trim();
  if (!id) return { class: 'unknown', risk: 70, label: 'No declared license' };
  const head = id.split(/\s+(?:OR|AND|WITH)\s+/i)[0].trim();
  if (PERMISSIVE.has(head)) return { class: 'permissive', risk: 5, label: `${id} (permissive)` };
  if (WEAK_COPYLEFT.has(head)) return { class: 'weak-copyleft', risk: 35, label: `${id} (weak copyleft)` };
  if (STRONG_COPYLEFT.has(head)) return { class: 'strong-copyleft', risk: 60, label: `${id} (strong copyleft)` };
  return { class: 'unknown', risk: 55, label: `${id} (unrecognized)` };
}
function severityRisk(word) {
  return { CRITICAL: 100, HIGH: 80, MODERATE: 55, MEDIUM: 55, LOW: 30 }[(word || '').toUpperCase()] || 50;
}

// Identical math to computeSignal() in scripts/lib/analyze.mjs.
function computeSignal(facts) {
  const components = [];
  {
    const sc = facts.scorecard;
    let value, evidence, confidence;
    if (sc && typeof sc.score === 'number') {
      value = round(clamp((10 - sc.score) / 10, 0, 1) * 100, 1);
      evidence = `OpenSSF Scorecard ${round(sc.score, 1)}/10 → inverted to ${value}/100 risk`;
      confidence = 'high';
    } else {
      value = null;
      evidence = 'no OpenSSF Scorecard returned — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({ key: 'security_posture', label: 'Security posture', weight: 0.25, value, evidence, source: 'OpenSSF Scorecard (via deps.dev)', confidence });
  }
  {
    const v = facts.vulns;
    let value, evidence, confidence;
    if (v && typeof v.count === 'number') {
      if (v.count === 0) {
        value = 0;
        evidence = 'no package advisories returned by OSV';
      } else {
        const base = severityRisk(v.max_severity);
        value = round(clamp(base * (0.7 + 0.3 * Math.min(1, v.count / 5)), 0, 100), 1);
        evidence = `${v.count} package advisor${v.count === 1 ? 'y' : 'ies'} across versions in OSV (max severity ${v.max_severity || 'unknown'})`;
      }
      confidence = 'high';
    } else {
      value = null;
      evidence = 'OSV lookup unavailable — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({ key: 'known_vulns', label: 'Known vulnerabilities', weight: 0.25, value, evidence, source: 'OSV.dev', confidence });
  }
  {
    const m = facts.maintenance;
    let value, evidence, confidence;
    if (m) {
      const staleness = (days) => clamp((days / 365) * 80, 0, 100);
      const relStale = m.last_release_days != null ? staleness(m.last_release_days) : null;
      const commitStale = m.last_commit_days != null ? staleness(m.last_commit_days) : null;
      const cadence = m.releases_past_year != null
        ? clamp((1 - Math.min(1, m.releases_past_year / 12)) * 60, 0, 60)
        : null;
      const parts = [relStale, commitStale, cadence].filter((x) => x != null);
      value = parts.length ? round(parts.reduce((s, x) => s + x, 0) / parts.length, 1) : 50;
      const bits = [];
      if (m.last_release_days != null) bits.push(`${m.last_release_days}d since last release`);
      if (m.last_commit_days != null) bits.push(`${m.last_commit_days}d since last commit`);
      if (m.releases_past_year != null) bits.push(`${m.releases_past_year} releases in the past year`);
      evidence = bits.join(', ') || 'limited maintenance metadata';
      confidence = parts.length >= 2 ? 'high' : 'medium';
    } else {
      value = null;
      evidence = 'no maintenance metadata returned — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({ key: 'maintenance', label: 'Maintenance / activity', weight: 0.20, value, evidence, source: 'ecosyste.ms / GitHub', confidence });
  }
  {
    const b = facts.bus_factor;
    let value, evidence, confidence;
    if (b && typeof b.top_share === 'number') {
      value = round(clamp((b.top_share - 0.2) / 0.7, 0, 1) * 100, 1);
      evidence = `top contributor authored ${round(b.top_share * 100)}% of commits` +
        (b.contributors != null ? ` across ${b.contributors} contributors` : '');
      confidence = b.contributors != null && b.contributors >= 5 ? 'high' : 'medium';
    } else {
      value = null;
      evidence = 'contributor breakdown unavailable — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({ key: 'bus_factor', label: 'Bus-factor (contributor concentration)', weight: 0.15, value, evidence, source: 'GitHub contributors', confidence });
  }
  {
    if (facts.license?.spdx_id) {
      const lic = classifyLicense(facts.license.spdx_id);
      components.push({
        key: 'license_risk', label: 'License obligations', weight: 0.15,
        value: round(lic.risk, 1),
        evidence: `${lic.label} → ${lic.class} obligations`,
        source: 'SPDX license id (local classification)',
        confidence: lic.class === 'unknown' ? 'low' : 'high',
      });
    } else {
      components.push({
        key: 'license_risk', label: 'License obligations', weight: 0.15,
        value: null,
        evidence: 'no SPDX license id returned — excluded from the combined signal',
        source: 'SPDX license id (via deps.dev)',
        confidence: 'low',
      });
    }
  }
  const available = components.filter((c) => typeof c.value === 'number');
  const availableWeight = available.reduce((s, c) => s + c.weight, 0);
  const score = availableWeight
    ? round(available.reduce((s, c) => s + c.value * c.weight, 0) / availableWeight)
    : null;
  let band = 'Low';
  if (score == null) band = 'Unavailable';
  else if (score >= 70) band = 'High';
  else if (score >= 50) band = 'Elevated';
  else if (score >= 30) band = 'Moderate';
  return {
    score,
    health_score: score == null ? null : round(100 - score),
    band,
    coverage: round(availableWeight * 100),
    components,
  };
}

function buildSummary(displayName, facts, signal) {
  const sc = signal.components.find((c) => c.key === 'security_posture');
  const vu = signal.components.find((c) => c.key === 'known_vulns');
  const mt = signal.components.find((c) => c.key === 'maintenance');
  const lic = signal.components.find((c) => c.key === 'license_risk');
  const parts = [];
  parts.push(
    `${displayName} carries an exploratory health/risk signal of ${signal.score}/100 ` +
    `(${signal.band}; health ${signal.health_score}/100), calculated from ${signal.coverage}% available source coverage.`,
  );
  parts.push(`Security posture: ${sc.evidence}.`);
  parts.push(`Vulnerabilities: ${vu.evidence}.`);
  parts.push(`Maintenance: ${mt.evidence}.`);
  parts.push(`${lic.evidence}.`);
  parts.push(
    'This is an exploratory signal from public open-source metadata — not a security audit, ' +
    'a certification, or an endorsement of the project.',
  );
  return parts.join(' ');
}

function assembleLivePackage({ slug, name, displayName, ecosystem, repo, snapshotDate, facts }) {
  const signal = computeSignal(facts);
  const summary = buildSummary(displayName, facts, signal);
  return {
    slug, name, display_name: displayName, ecosystem, repo: repo || null,
    data_source: 'live-lookup', snapshot_date: snapshotDate, facts, signal, summary,
  };
}

// One bounded JSON fetch. Never throws — callers get { ok, status, json }
// and degrade the affected sub-signal, same policy as the offline ingest.
async function liveFetch(url, opts = {}, timeoutMs = LIVE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, json: null, timedOut: err.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}
const depsDevSystem = (ecosystem) => (ecosystem === 'pypi' ? 'PYPI' : 'NPM');
function daysSince(dateStr) {
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86400000));
}
function estimateCadence(versionsCount, firstReleaseAt) {
  const days = daysSince(firstReleaseAt);
  if (!days || days <= 0) return null;
  return Math.round((versionsCount / days) * 365);
}

// --- deps.dev: licenses, advisories, OpenSSF Scorecard, GitHub repo link ---
async function fetchDepsDevLive(ecosystem, name, timeoutMs = LIVE_TIMEOUT_MS) {
  const system = depsDevSystem(ecosystem);
  const base = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`;
  const meta = await liveFetch(base, {}, timeoutMs);
  if (!meta.ok) return { found: meta.status !== 404, license: null, scorecard: null, version: null, repo: null };
  const versions = meta.json.versions || [];
  const def = versions.find((v) => v.isDefault) || versions[versions.length - 1];
  const version = def?.versionKey?.version || null;
  let license = null;
  let scorecard = null;
  let repo = null;
  if (version) {
    const vmeta = await liveFetch(`${base}/versions/${encodeURIComponent(version)}`, {}, timeoutMs);
    if (vmeta.ok) {
      const spdx = (vmeta.json.licenses && vmeta.json.licenses[0]) || null;
      if (spdx) license = { spdx_id: spdx };
      const proj = (vmeta.json.relatedProjects || []).find((pr) => pr.projectKey?.id);
      if (proj?.projectKey?.id) {
        if (proj.projectKey.id.startsWith('github.com/')) repo = proj.projectKey.id.slice('github.com/'.length);
        const pmeta = await liveFetch(`https://api.deps.dev/v3/projects/${encodeURIComponent(proj.projectKey.id)}`, {}, timeoutMs);
        const s = pmeta.ok ? pmeta.json.scorecard?.overallScore : null;
        if (typeof s === 'number') scorecard = { score: s };
      }
    }
  }
  return { found: true, license, scorecard, version, repo };
}

// --- OSV.dev: known vulnerabilities ----------------------------------------
async function fetchOSVLive(ecosystem, name, timeoutMs = LIVE_TIMEOUT_MS) {
  const ecoLabel = ecosystem === 'pypi' ? 'PyPI' : 'npm';
  const r = await liveFetch('https://api.osv.dev/v1/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name, ecosystem: ecoLabel } }),
  }, timeoutMs);
  if (!r.ok) return null;
  const vulns = r.json.vulns || [];
  const order = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };
  let maxSev = null;
  let maxRank = 0;
  for (const v of vulns) {
    const sev = (v.database_specific?.severity || v.severity?.[0]?.type || '').toUpperCase();
    const rank = order[sev] || 0;
    if (rank > maxRank) { maxRank = rank; maxSev = sev; }
  }
  return { count: vulns.length, max_severity: maxSev };
}

// --- ecosyste.ms: maintenance / repo metadata + downloads ------------------
async function fetchEcosystemsLive(ecosystem, name, timeoutMs = LIVE_TIMEOUT_MS) {
  const registry = ecosystem === 'pypi' ? 'pypi.org' : 'npmjs.org';
  const r = await liveFetch(`https://packages.ecosyste.ms/api/v1/registries/${registry}/packages/${encodeURIComponent(name)}`, {}, timeoutMs);
  if (!r.ok) return null;
  const j = r.json;
  return {
    last_release_days: j.latest_release_published_at ? daysSince(j.latest_release_published_at) : null,
    releases_past_year: typeof j.versions_count === 'number' && j.first_release_published_at
      ? estimateCadence(j.versions_count, j.first_release_published_at) : null,
    last_commit_days: null,
    downloads: j.downloads != null && j.downloads_period === 'last-month'
      ? { last_month: Number(j.downloads), source: 'ecosyste.ms' } : null,
  };
}

// --- Official registries: current version + package metadata ---------------
async function fetchRegistryLive(ecosystem, name, timeoutMs = LIVE_TIMEOUT_MS) {
  if (ecosystem === 'pypi') {
    const r = await liveFetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {}, timeoutMs);
    if (!r.ok || !r.json?.info) return { found: r.status !== 404, registry: null, downloads: null };
    const info = r.json.info;
    return {
      found: true,
      registry: {
        current_version: info.version || null, requires_runtime: info.requires_python || null,
        description: info.summary || null, package_url: `https://pypi.org/project/${encodeURIComponent(name)}/`,
        weekly_downloads: null, source: 'PyPI JSON API',
      },
      downloads: null, // pypistats.org (the ingest's PyPI download source) does not allow browser CORS
    };
  }
  const [meta, downloads] = await Promise.all([
    liveFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {}, timeoutMs),
    liveFetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`, {}, timeoutMs),
  ]);
  if (!meta.ok) return { found: meta.status !== 404, registry: null, downloads: null };
  const j = meta.json;
  return {
    found: true,
    registry: {
      current_version: j.version || null, requires_runtime: j.engines?.node || null,
      description: j.description || null, package_url: `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
      weekly_downloads: null, source: 'npm Registry API',
    },
    downloads: downloads.ok && typeof downloads.json?.downloads === 'number'
      ? { last_month: downloads.json.downloads, source: 'npm downloads API' } : null,
  };
}

// --- GitHub: last commit + contributor concentration (bus-factor) ----------
async function fetchGitHubLive(repo, timeoutMs = LIVE_TIMEOUT_MS) {
  if (!repo) return { last_commit_days: null, bus_factor: null, repository: null };
  const [repoRes, contribRes] = await Promise.all([
    liveFetch(`https://api.github.com/repos/${repo}`, {}, timeoutMs),
    liveFetch(`https://api.github.com/repos/${repo}/contributors?per_page=100&anon=false`, {}, timeoutMs),
  ]);
  const r = repoRes.ok ? repoRes.json : null;
  const lastCommitDays = r?.pushed_at ? daysSince(r.pushed_at) : null;
  let busFactor = null;
  if (contribRes.ok && Array.isArray(contribRes.json) && contribRes.json.length) {
    const counts = contribRes.json.map((c) => c.contributions || 0);
    const total = counts.reduce((s, x) => s + x, 0);
    if (total > 0) busFactor = { top_share: counts[0] / total, contributors: contribRes.json.length };
  }
  const repository = r ? {
    stars: r.stargazers_count ?? null, forks: r.forks_count ?? null, open_issues: r.open_issues_count ?? null,
    watchers: r.subscribers_count ?? null, archived: Boolean(r.archived), created_at: r.created_at || null,
    pushed_at: r.pushed_at || null, default_branch: r.default_branch || null,
    topics: Array.isArray(r.topics) ? r.topics.slice(0, 8) : [], source_url: r.html_url || `https://github.com/${repo}`,
  } : null;
  return { last_commit_days: lastCommitDays, bus_factor: busFactor, repository };
}

// Gather every fact for one package straight from the browser. Only returns
// { notFound: true } when BOTH deps.dev and the official registry come back
// with an explicit 404 — a single missing/slow source just lowers that
// sub-signal's confidence, exactly like the offline ingest.
async function gatherFactsLive(ecosystem, name) {
  const [depsDev, vulns, eco, reg] = await Promise.all([
    fetchDepsDevLive(ecosystem, name),
    fetchOSVLive(ecosystem, name),
    fetchEcosystemsLive(ecosystem, name),
    fetchRegistryLive(ecosystem, name),
  ]);
  if (!depsDev.found && !reg.found) return { notFound: true };

  const gh = depsDev.repo ? await fetchGitHubLive(depsDev.repo) : { last_commit_days: null, bus_factor: null, repository: null };
  const maintenance = (eco || gh.last_commit_days != null) ? {
    last_release_days: eco?.last_release_days ?? null,
    last_commit_days: gh.last_commit_days,
    releases_past_year: eco?.releases_past_year ?? null,
  } : null;

  return {
    notFound: false,
    repo: depsDev.repo || null,
    facts: {
      scorecard: depsDev.scorecard,
      vulns,
      maintenance,
      bus_factor: gh.bus_factor,
      github: gh.repository,
      registry: reg.registry,
      license: depsDev.license,
      downloads: reg.downloads || eco?.downloads || null,
    },
  };
}

async function liveAnalyze(ecosystem, name) {
  const cacheKey = `${ecosystem}:${name.toLowerCase()}`;
  if (liveCache.has(cacheKey)) return liveCache.get(cacheKey);
  const gathered = await gatherFactsLive(ecosystem, name);
  let result;
  if (gathered.notFound) {
    result = { notFound: true };
  } else {
    const slug = `live-${ecosystem}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const pkg = assembleLivePackage({
      slug, name, displayName: name, ecosystem, repo: gathered.repo,
      snapshotDate: new Date().toISOString().slice(0, 10), facts: gathered.facts,
    });
    result = { notFound: false, pkg };
  }
  liveCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Dependency risk rollup — scores a package's direct runtime dependencies
// with the exact same computeSignal() above, reading deps.dev's resolved
// dependency graph. Deliberately skips the GitHub calls (anonymous GitHub
// REST is capped at 60 req/hr) so scoring up to 8 dependencies stays well
// inside budget; bus-factor just reads "unavailable" for these rows — the
// same degrade-don't-invent policy as everywhere else in this app.
// ---------------------------------------------------------------------------
async function poolMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchDirectDependencies(ecosystem, name, timeoutMs) {
  const system = depsDevSystem(ecosystem);
  const base = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`;
  const meta = await liveFetch(base, {}, timeoutMs);
  if (!meta.ok) return [];
  const versions = meta.json.versions || [];
  const def = versions.find((v) => v.isDefault) || versions[versions.length - 1];
  const version = def?.versionKey?.version;
  if (!version) return [];
  const deps = await liveFetch(`${base}/versions/${encodeURIComponent(version)}:dependencies`, {}, timeoutMs);
  if (!deps.ok) return [];
  return (deps.json.nodes || [])
    .filter((n) => n.relation === 'DIRECT')
    .slice(0, DEP_MAX)
    .map((n) => ({ name: n.versionKey.name, system: n.versionKey.system, version: n.versionKey.version }));
}

function worstFactor(signal) {
  const available = signal.components.filter((c) => typeof c.value === 'number');
  if (!available.length) return { label: 'No factors available', evidence: 'every public source was missing, timed out, or rate-limited' };
  return available.reduce((a, b) => (b.value > a.value ? b : a));
}

// Score one dependency with deps.dev (license + scorecard) + OSV + ecosyste.ms
// only — no GitHub call. `budget()` returns ms remaining in the rollup's
// overall wall-clock budget so a slow batch degrades rather than hangs.
async function scoreDependency(dep, budget) {
  if (budget() <= 300) return null;
  const ecosystem = dep.system === 'PYPI' ? 'pypi' : 'npm';
  const timeoutMs = Math.max(1500, Math.min(DEP_TIMEOUT_MS, budget()));
  const base = `https://api.deps.dev/v3/systems/${dep.system}/packages/${encodeURIComponent(dep.name)}`;
  const [vmeta, vulns, eco] = await Promise.all([
    liveFetch(`${base}/versions/${encodeURIComponent(dep.version)}`, {}, timeoutMs),
    fetchOSVLive(ecosystem, dep.name, timeoutMs),
    fetchEcosystemsLive(ecosystem, dep.name, timeoutMs),
  ]);
  let license = null;
  let scorecard = null;
  if (vmeta.ok) {
    const spdx = (vmeta.json.licenses && vmeta.json.licenses[0]) || null;
    if (spdx) license = { spdx_id: spdx };
    const proj = (vmeta.json.relatedProjects || []).find((pr) => pr.projectKey?.id);
    if (proj?.projectKey?.id && budget() > 300) {
      const pmeta = await liveFetch(`https://api.deps.dev/v3/projects/${encodeURIComponent(proj.projectKey.id)}`, {}, Math.max(1500, Math.min(DEP_TIMEOUT_MS, budget())));
      const s = pmeta.ok ? pmeta.json.scorecard?.overallScore : null;
      if (typeof s === 'number') scorecard = { score: s };
    }
  }
  const facts = {
    scorecard, vulns,
    maintenance: eco ? { last_release_days: eco.last_release_days, last_commit_days: null, releases_past_year: eco.releases_past_year } : null,
    bus_factor: null,
    license,
  };
  const signal = computeSignal(facts);
  return { name: dep.name, ecosystem, signal, worst: worstFactor(signal) };
}

function depsCardShell(inner) {
  return `<h3>Direct dependencies</h3>${inner}`;
}
function depRow(s) {
  const color = bandColor(s.signal.band);
  return `
    <div class="dep-row">
      <span class="dep-name">${esc(s.name)}<span class="eco-tag">${esc(s.ecosystem)}</span></span>
      <span class="dep-pill" style="color:${color};background:${bandBg(s.signal.band)}">${s.signal.score == null ? '—' : s.signal.score}<small>${esc(s.signal.band)}</small></span>
      <span class="dep-note">${esc(s.worst.evidence || s.worst.label)}</span>
    </div>`;
}
function depRowFailed(name) {
  return `
    <div class="dep-row dep-row-failed">
      <span class="dep-name">${esc(name)}</span>
      <span class="dep-pill unscored">—</span>
      <span class="dep-note">could not be scored (timeout or rate limit)</span>
    </div>`;
}

async function renderDependencyRollup(slug, ecosystem, name) {
  const deadline = Date.now() + DEP_BUDGET_MS;
  const budget = () => deadline - Date.now();
  const stillCurrent = () => state.selected === slug && $('#depsCard');
  try {
    const deps = await fetchDirectDependencies(ecosystem, name, Math.min(DEP_TIMEOUT_MS, budget()));
    if (!stillCurrent()) return;
    if (!deps.length) {
      $('#depsCard').innerHTML = depsCardShell('<p class="gauge-note">No direct runtime dependencies reported by deps.dev, or the dependency graph was unavailable.</p>');
      return;
    }
    const scored = await poolMap(deps, DEP_POOL_SIZE, (dep) => scoreDependency(dep, budget).catch(() => null));
    if (!stillCurrent()) return;
    const rows = scored.map((s, idx) => (s ? depRow(s) : depRowFailed(deps[idx].name))).join('');
    $('#depsCard').innerHTML = depsCardShell(`
      <div class="dep-list">${rows}</div>
      <p class="gauge-note" style="margin-top:12px">Top ${deps.length} direct runtime ${deps.length === 1 ? 'dependency' : 'dependencies'} from deps.dev's resolved graph, scored with the same signal above. GitHub bus-factor is skipped here to stay inside anonymous rate limits, so that sub-signal reads unavailable for every row.</p>
    `);
  } catch (err) {
    if (stillCurrent()) $('#depsCard').innerHTML = depsCardShell(`<p class="gauge-note">Direct-dependency lookup failed or timed out (${esc(err.message)}).</p>`);
  }
}

// ---------------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------------

// Donut gauge for the 0–100 signal score.
function gauge(score, band) {
  const r = 58, c = 70, circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const color = bandColor(band);
  return `
  <div class="gauge">
    <svg viewBox="0 0 140 140" aria-label="Risk signal ${score} of 100">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--s3)" stroke-width="11"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${circ}"
        stroke-dashoffset="${circ * (1 - frac)}" transform="rotate(-90 ${c} ${c})"/>
    </svg>
    <div class="num"><b style="color:${color}">${score}</b><span>/ 100 risk</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Leaderboard + chips
// ---------------------------------------------------------------------------
function renderBadge() {
  const badge = $('#sourceBadge');
  const idx = state.index;
  if (idx.data_source === 'sample') {
    throw new Error('Synthetic data is blocked from this public build.');
  } else {
    badge.className = 'badge';
    badge.textContent = `Verified live snapshot · ${idx.generated} · ${idx.packages.length} packages`;
    badge.title = idx.note || '';
  }
}

function renderLeaderboard() {
  const board = $('#leaderboard');
  board.innerHTML = '';
  const q = $('#search').value.trim().toLowerCase();
  const rows = state.index.packages.filter(
    (p) => !q || p.display_name.toLowerCase().includes(q) || p.ecosystem.toLowerCase().includes(q) || (p.repo || '').toLowerCase().includes(q),
  );
  if (!rows.length) {
    board.appendChild(el('div', 'empty', 'No matching packages.'));
    return;
  }
  rows.forEach((p, i) => {
    const row = el('button', 'lb-row');
    row.innerHTML = `
      <span class="lb-rank">${String(i + 1).padStart(2, '0')}</span>
      <span class="lb-name">${esc(p.display_name)}<span class="eco-tag">${esc(p.ecosystem)}</span><small>${esc(p.repo || '')}</small></span>
      <span class="lb-vol">${p.health_score}<small>health</small></span>
      <span class="score-pill" style="color:${bandColor(p.signal_band)};background:${bandBg(p.signal_band)}">
        ${p.signal_score}<small>${p.signal_band} risk</small></span>`;
    row.addEventListener('click', () => selectPackage(p.slug));
    board.appendChild(row);
  });
}

function renderChips() {
  const wrap = $('#packageChips');
  wrap.innerHTML = '';
  state.index.packages.forEach((p) => {
    const chip = el('button', 'chip');
    chip.dataset.slug = p.slug;
    chip.innerHTML = `<span class="dot" style="background:${bandColor(p.signal_band)}"></span>${esc(p.display_name)}`;
    chip.addEventListener('click', () => {
      if (state.compareMode) toggleCompare(p.slug);
      else selectPackage(p.slug);
    });
    wrap.appendChild(chip);
  });
}
function syncChips() {
  document.querySelectorAll('.chip').forEach((chip) => {
    const s = chip.dataset.slug;
    const active = state.compareMode ? state.compareSel.includes(s) : state.selected === s;
    chip.classList.toggle('active', active);
  });
}

// A sub-signal row: value bar + evidence + source + confidence label.
function signalComponent(cmp, color) {
  const available = typeof cmp.value === 'number';
  return `
    <div class="sig-comp">
      <div class="sc-top">
        <span class="sc-label">${esc(cmp.label)} <span class="sc-weight">× ${cmp.weight}</span></span>
        <span class="sc-val">${available ? `${cmp.value}/100` : 'Unavailable'}</span>
      </div>
      <div class="meter"><div style="width:${available ? cmp.value : 0}%;background:${color}"></div></div>
      <div class="sc-ev">${esc(cmp.evidence)}</div>
      <div class="sc-meta">
        <span class="tag src">${esc(cmp.source)}</span>
        <span class="tag conf-${esc(cmp.confidence)}">${esc(cmp.confidence)} confidence</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
async function selectPackage(slug) {
  state.selected = slug;
  syncChips();
  const p = await loadPackage(slug);
  const d = $('#detail');
  d.hidden = false;
  $('#compare').hidden = true;

  const sig = p.signal;
  const color = bandColor(sig.band);
  const f = p.facts;
  const repoHref = p.repo ? `https://github.com/${p.repo}` : null;
  const lic = sig.components.find((c) => c.key === 'license_risk');
  const gh = f.github;
  const registry = f.registry;
  const formatCount = (value) => {
    if (value == null) return '—';
    return Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
  };

  d.innerHTML = `
    <button class="back" id="backBtn">← back to leaderboard</button>
    <div class="dhead">
      <div>
        <h2>${esc(p.display_name)} <span class="eco-tag">${esc(p.ecosystem)}</span>${p.data_source === 'live-lookup' ? ' <span class="live-badge">Live lookup</span>' : ''}</h2>
        <div class="cfpb-name">${repoHref ? `repo: <a href="${esc(repoHref)}" target="_blank" rel="noopener">${esc(p.repo)}</a> · ` : ''}snapshot ${esc(p.snapshot_date)}</div>
      </div>
    </div>

    <div class="summary">${esc(p.summary)}</div>
    <div class="report-actions">
      <button type="button" id="copyReportLink">Copy report link</button>
      <button type="button" id="downloadReport">Download report</button>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Health / risk signal</h3>
        <div class="gauge-wrap">
          ${gauge(sig.score, sig.band)}
          <div>
            <span class="band-tag" style="color:${color};background:${bandBg(sig.band)}">${sig.band} risk</span>
            <p class="gauge-note">A transparent 0–100 score using only available public-data sub-signals (below).
            Higher means more reason to look closer — health reads as <strong>${sig.health_score}/100</strong>.
            Source coverage is <strong>${sig.coverage}%</strong>. Missing sources are excluded, never filled with assumed values.
            This is <strong>not</strong> a verdict or an endorsement.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>At a glance</h3>
        <div class="kpi-row">
          <div class="kpi"><div class="v">${f.scorecard ? f.scorecard.score : '—'}</div><div class="l">OpenSSF Scorecard</div></div>
          <div class="kpi"><div class="v">${f.vulns ? f.vulns.count : '—'}</div><div class="l">OSV advisories across versions</div></div>
        </div>
        <div class="kpi-row" style="margin-bottom:0">
          <div class="kpi"><div class="v">${f.maintenance && f.maintenance.last_release_days != null ? f.maintenance.last_release_days + 'd' : '—'}</div><div class="l">Since last release</div></div>
          <div class="kpi"><div class="v">${f.bus_factor ? Math.round(f.bus_factor.top_share * 100) + '%' : '—'}</div><div class="l">Top contributor</div></div>
          <div class="kpi"><div class="v">${f.downloads && f.downloads.last_month != null ? fmtDownloads(f.downloads.last_month) : '—'}</div><div class="l">Downloads / month${f.downloads ? ` (${esc(f.downloads.source)})` : ''}</div></div>
        </div>
      </div>

      <div class="card full">
        <h3>How the health / risk signal is calculated</h3>
        ${sig.components.map((cmp) => signalComponent(cmp, color)).join('')}
        <p class="gauge-note" style="margin-top:14px">
          Score = weighted average of available factors only. Each factor is in risk-direction (higher = more reason to look closer),
          with its named source and a confidence label. Missing sources are excluded rather than assigned invented neutral values.
        </p>
      </div>

      <div class="card">
        <h3>License</h3>
        <div class="kpi" style="min-width:auto">
          <div class="v" style="font-size:18px">${esc(f.license?.spdx_id || 'Unknown')}</div>
          <div class="l">${esc(lic.evidence)}</div>
        </div>
      </div>
      <div class="card">
        <h3>Maintenance</h3>
        <div class="kpi-row" style="margin-bottom:0">
          <div class="kpi"><div class="v">${f.maintenance && f.maintenance.last_commit_days != null ? f.maintenance.last_commit_days + 'd' : '—'}</div><div class="l">Since last commit</div></div>
          <div class="kpi"><div class="v">${f.maintenance && f.maintenance.releases_past_year != null ? f.maintenance.releases_past_year : '—'}</div><div class="l">Releases / yr</div></div>
        </div>
      </div>

      <div class="card full">
        <h3>GitHub repository pulse</h3>
        ${gh ? `
          <div class="kpi-row">
            <div class="kpi"><div class="v">${formatCount(gh.stars)}</div><div class="l">Stars</div></div>
            <div class="kpi"><div class="v">${formatCount(gh.forks)}</div><div class="l">Forks</div></div>
            <div class="kpi"><div class="v">${formatCount(gh.open_issues)}</div><div class="l">Open issues + PRs</div></div>
            <div class="kpi"><div class="v">${formatCount(gh.watchers)}</div><div class="l">Subscribers</div></div>
          </div>
          <p class="gauge-note">
            Default branch: <strong>${esc(gh.default_branch || 'unknown')}</strong> ·
            Archived: <strong>${gh.archived ? 'yes' : 'no'}</strong> ·
            Last repository push: <strong>${f.maintenance?.last_commit_days ?? '—'}d ago</strong>.
            These are repository activity facts, not quality judgments.
          </p>
          <a class="evidence-link" href="${esc(gh.source_url)}" target="_blank" rel="noopener">Open GitHub repository ↗</a>
        ` : '<p class="gauge-note">GitHub repository metadata was unavailable for this snapshot.</p>'}
      </div>

      <div class="card full">
        <h3>Registry facts</h3>
        ${registry ? `
          <div class="kpi-row">
            <div class="kpi"><div class="v">${esc(registry.current_version || '—')}</div><div class="l">Current registry version</div></div>
            <div class="kpi"><div class="v" style="font-size:18px">${esc(registry.requires_runtime || '—')}</div><div class="l">${p.ecosystem === 'npm' ? 'Node requirement' : 'Python requirement'}</div></div>
          </div>
          <p class="gauge-note">${esc(registry.description || 'No registry description returned.')}</p>
          <a class="evidence-link" href="${esc(registry.package_url)}" target="_blank" rel="noopener">Open ${esc(registry.source)} record ↗</a>
        ` : '<p class="gauge-note">Official registry metadata was unavailable for this snapshot.</p>'}
      </div>

      <div class="card full" id="depsCard">
        <h3>Direct dependencies</h3>
        <p class="gauge-note">Loading direct dependency risk from deps.dev…</p>
      </div>
    </div>`;

  $('#backBtn').addEventListener('click', () => {
    d.hidden = true;
    state.selected = null;
    syncChips();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#copyReportLink').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('ecosystem', p.ecosystem);
    url.searchParams.set('package', p.name);
    await navigator.clipboard.writeText(url.toString());
    $('#copyReportLink').textContent = 'Link copied';
  });
  $('#downloadReport').addEventListener('click', () => {
    const report = [
      `OpenSourceGraph report: ${p.display_name}`,
      `Snapshot: ${p.snapshot_date}`,
      `Ecosystem: ${p.ecosystem}`,
      `Health: ${p.signal.health_score}/100`,
      `Risk signal: ${p.signal.score}/100 (${p.signal.band})`,
      `Source coverage: ${p.signal.coverage}%`,
      '',
      ...p.signal.components.flatMap((component) => [
        `${component.label}: ${component.value == null ? 'Unavailable' : `${component.value}/100`}`,
        `Evidence: ${component.evidence}`,
        `Source: ${component.source} (${component.confidence} confidence)`,
        '',
      ]),
      'Exploratory public-data signal only. Not a security audit, certification, or endorsement.',
    ].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([report], { type: 'text/plain' }));
    link.download = `opensourcegraph-${p.ecosystem}-${p.name.replace(/[^a-z0-9]+/gi, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  renderDependencyRollup(p.slug, p.ecosystem, p.name);
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const ecoLabel = (e) => (e === 'pypi' ? 'PyPI' : 'npm');

// Live package search: fetch facts for `name` directly from the browser
// (deps.dev, OSV, ecosyste.ms, the official registry, GitHub) and score them
// with the exact same computeSignal() the curated snapshots use. Falls back
// to the other ecosystem automatically if the chosen one comes back
// not-found, so "auto-detect npm vs PyPI" doesn't require guessing right.
async function analyzePackage(ecosystem, name, updateUrl = true) {
  const status = $('#analyzeStatus');
  const button = $('#analyzeButton');
  status.className = 'analyze-status';
  status.textContent = `Fetching current ${ecoLabel(ecosystem)}, deps.dev, OSV, and ecosyste.ms facts, live, from your browser…`;
  button.disabled = true;
  try {
    let activeEco = ecosystem;
    let result = await liveAnalyze(activeEco, name);
    if (result.notFound) {
      const other = activeEco === 'pypi' ? 'npm' : 'pypi';
      status.textContent = `Not found on ${ecoLabel(activeEco)} — trying ${ecoLabel(other)}…`;
      const retry = await liveAnalyze(other, name);
      if (!retry.notFound) {
        activeEco = other;
        result = retry;
        $('#analyzeEcosystem').value = other;
      }
    }
    if (result.notFound) {
      throw new Error(`No package named "${name}" was found on npm or PyPI. Check the spelling — it may also be unpublished or private.`);
    }
    const pkg = result.pkg;
    dynamicPackages.set(pkg.slug, pkg);
    if (!state.index.packages.some((item) => item.slug === pkg.slug)) {
      state.index.packages.unshift({
        slug: pkg.slug, display_name: pkg.display_name, name: pkg.name, ecosystem: pkg.ecosystem,
        repo: pkg.repo, signal_score: pkg.signal.score, health_score: pkg.signal.health_score,
        signal_band: pkg.signal.band,
      });
      renderChips();
      renderLeaderboard();
    }
    status.textContent = `Live lookup built client-side from named public sources · ${pkg.snapshot_date}`;
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('ecosystem', activeEco);
      url.searchParams.set('package', name);
      history.replaceState(null, '', url);
    }
    await selectPackage(pkg.slug);
  } catch (error) {
    status.className = 'analyze-status error';
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Compare view
// ---------------------------------------------------------------------------
function toggleCompare(slug) {
  const sel = state.compareSel;
  const i = sel.indexOf(slug);
  if (i >= 0) sel[i] = null;
  else if (!sel[0]) sel[0] = slug;
  else if (!sel[1]) sel[1] = slug;
  else sel[1] = slug; // replace second
  syncChips();
  renderCompare();
}

async function renderCompare() {
  const box = $('#compare');
  box.hidden = false;
  $('#detail').hidden = true;
  const [a, b] = state.compareSel;
  if (!a || !b) {
    box.innerHTML = `<div class="empty">Pick two packages above to compare them side by side.</div>`;
    return;
  }
  const [pa, pb] = await Promise.all([loadPackage(a), loadPackage(b)]);
  const col = (p) => {
    const color = bandColor(p.signal.band);
    return `
    <div class="card">
      <h3>${esc(p.display_name)} <span class="eco-tag">${esc(p.ecosystem)}</span></h3>
      <div class="gauge-wrap" style="margin-bottom:14px">
        ${gauge(p.signal.score, p.signal.band)}
        <span class="band-tag" style="color:${color};background:${bandBg(p.signal.band)}">${p.signal.band} · health ${p.signal.health_score}</span>
      </div>
      ${p.signal.components.map((cmp) => signalComponent(cmp, color)).join('')}
    </div>`;
  };
  box.innerHTML = `<div class="cmp-grid">${col(pa)}${col(pb)}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    state.index = await fetchJSON(`${DATA}/index.json?v=${DATA_VERSION}`);
    if (state.index.data_source !== 'live') {
      throw new Error('Only verified live API snapshots are allowed.');
    }
  } catch (err) {
    $('#leaderboard').innerHTML = `<div class="empty">Could not load data (${esc(err.message)}).<br>
      Serve this folder over HTTP — e.g. <code>npx serve opensourcegraph/src</code> — rather than opening the file directly.</div>`;
    return;
  }
  renderBadge();
  renderChips();
  renderLeaderboard();

  $('#search').addEventListener('input', renderLeaderboard);
  $('#analyzeForm').addEventListener('submit', (event) => {
    event.preventDefault();
    analyzePackage($('#analyzeEcosystem').value, $('#analyzeName').value.trim());
  });
  $('#compareToggle').addEventListener('change', (e) => {
    state.compareMode = e.target.checked;
    $('#boardLabel').textContent = state.compareMode ? 'Pick two to compare' : 'Risk leaderboard';
    state.compareSel = [null, null];
    state.selected = null;
    syncChips();
    if (state.compareMode) {
      $('#detail').hidden = true;
      renderCompare();
    } else {
      $('#compare').hidden = true;
    }
  });

  const params = new URLSearchParams(location.search);
  const requestedPackage = params.get('package');
  if (requestedPackage) {
    const ecosystem = params.get('ecosystem') === 'pypi' ? 'pypi' : 'npm';
    $('#analyzeEcosystem').value = ecosystem;
    $('#analyzeName').value = requestedPackage;
    analyzePackage(ecosystem, requestedPackage, false);
  }
}

boot();
