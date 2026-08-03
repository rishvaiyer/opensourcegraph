// OpenSourceGraph — live ingest from public open-source APIs.
//
// For each curated package it gathers normalized "facts" from free, no-OAuth
// endpoints and bakes them into static JSON the dashboard reads:
//   * deps.dev      — licenses, advisories, OpenSSF Scorecard
//   * OSV.dev       — known vulnerabilities (count + max severity)
//   * ecosyste.ms   — registry/repo maintenance metadata
//   * GitHub REST   — last commit + contributor concentration (bus-factor)
//   * SPDX          — license id classified locally (no fetch) in analyze.mjs
//
// BOUNDED exactly like complaintgraph's CFPB ingest: every request has an
// AbortController timeout, the whole run has a wall-clock budget, and if
// ANYTHING fails we log it and leave the committed SAMPLE data fully intact, so
// the page always renders (clearly labeled). We build everything in memory and
// only touch disk if every package succeeds — never a half-live mix.
//
// Usage:  node scripts/ingest.mjs
// Env:    GITHUB_TOKEN              (optional — raises GitHub rate limit only)
//         OSG_REQUEST_TIMEOUT_MS    (default 15000)
//         OSG_TOTAL_BUDGET_MS       (default 240000)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPackage, PACKAGES } from './lib/analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

const REQUEST_TIMEOUT_MS = Number(process.env.OSG_REQUEST_TIMEOUT_MS || 15000);
const TOTAL_BUDGET_MS = Number(process.env.OSG_TOTAL_BUDGET_MS || 240000);
const START = Date.now();
const UA = 'OpenSourceGraph/0.1 (+https://github.com/unevil-warden/unevil)';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function daysBetween(then, now = Date.now()) {
  const t = new Date(then).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 86400000));
}
function budgetLeft() {
  return TOTAL_BUDGET_MS - (Date.now() - START);
}

// One bounded JSON request. Returns null on any failure (HTTP error, timeout,
// parse error) — callers degrade gracefully rather than throwing.
async function getJSON(url, opts = {}) {
  if (budgetLeft() <= 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(REQUEST_TIMEOUT_MS, budgetLeft()));
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...(opts.headers || {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- deps.dev: licenses, advisories, OpenSSF Scorecard ----------------------
async function fetchDepsDev(pkg) {
  const system = pkg.ecosystem === 'pypi' ? 'pypi' : 'npm';
  const base = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(pkg.name)}`;
  const meta = await getJSON(base);
  if (!meta) return { license: null, scorecard: null };

  // Pick the latest (or default) version to read project-level signals.
  const versions = meta.versions || [];
  const def = versions.find((v) => v.isDefault) || versions[versions.length - 1];
  let license = null;
  let scorecard = null;
  if (def?.versionKey?.version) {
    const vurl = `${base}/versions/${encodeURIComponent(def.versionKey.version)}`;
    const vmeta = await getJSON(vurl);
    const spdx = (vmeta?.licenses && vmeta.licenses[0]) || null;
    if (spdx) license = { spdx_id: spdx };
    // Scorecard is attached to a linked project (the source repo).
    const proj = (vmeta?.relatedProjects || []).find((p) => p.projectKey?.id);
    if (proj?.projectKey?.id) {
      const purl = `https://api.deps.dev/v3/projects/${encodeURIComponent(proj.projectKey.id)}`;
      const pmeta = await getJSON(purl);
      const s = pmeta?.scorecard?.overallScore;
      if (typeof s === 'number') scorecard = { score: s };
    }
  }
  return { license, scorecard };
}

// --- OSV.dev: known vulnerabilities ----------------------------------------
async function fetchOSV(pkg) {
  const ecosystem = pkg.ecosystem === 'pypi' ? 'PyPI' : 'npm';
  const body = JSON.stringify({ package: { name: pkg.name, ecosystem } });
  const json = await getJSON('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!json) return null;
  const vulns = json.vulns || [];
  const order = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };
  let maxSev = null;
  let maxRank = 0;
  for (const v of vulns) {
    // Severity may live in database_specific or a CVSS-derived label.
    const sev = (v.database_specific?.severity || v.severity?.[0]?.type || '').toUpperCase();
    const rank = order[sev] || 0;
    if (rank > maxRank) { maxRank = rank; maxSev = sev; }
  }
  return { count: vulns.length, max_severity: maxSev };
}

// --- ecosyste.ms: maintenance / repo metadata ------------------------------
async function fetchEcosystems(pkg) {
  const registry = pkg.ecosystem === 'pypi' ? 'pypi.org' : 'npmjs.org';
  const url = `https://packages.ecosyste.ms/api/v1/registries/${registry}/packages/${encodeURIComponent(pkg.name)}`;
  const json = await getJSON(url);
  if (!json) return null;
  return {
    last_release_days: json.latest_release_published_at ? daysBetween(json.latest_release_published_at) : null,
    releases_past_year: typeof json.versions_count === 'number' && json.first_release_published_at
      ? estimateCadence(json.versions_count, json.first_release_published_at)
      : null,
    last_commit_days: null, // filled from GitHub below when available
  };
}

// --- Official registries: current version + package metadata ----------------
async function fetchRegistry(pkg) {
  if (pkg.ecosystem === 'pypi') {
    const json = await getJSON(`https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`);
    if (!json?.info) return null;
    return {
      current_version: json.info.version || null,
      requires_runtime: json.info.requires_python || null,
      description: json.info.summary || null,
      package_url: `https://pypi.org/project/${encodeURIComponent(pkg.name)}/`,
      weekly_downloads: null,
      source: 'PyPI JSON API',
    };
  }

  const [meta, downloads] = await Promise.all([
    getJSON(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`),
    getJSON(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg.name)}`),
  ]);
  if (!meta) return null;
  return {
    current_version: meta.version || null,
    requires_runtime: meta.engines?.node || null,
    description: meta.description || null,
    package_url: `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`,
    weekly_downloads: typeof downloads?.downloads === 'number' ? downloads.downloads : null,
    source: 'npm Registry API',
  };
}
function estimateCadence(versionsCount, firstReleaseAt) {
  const days = daysBetween(firstReleaseAt);
  if (!days || days <= 0) return null;
  return Math.round((versionsCount / days) * 365);
}

// --- GitHub: last commit + contributor concentration (bus-factor) ----------
async function fetchGitHub(pkg) {
  if (!pkg.repo) return { last_commit_days: null, bus_factor: null, repository: null };
  const headers = {};
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const repo = await getJSON(`https://api.github.com/repos/${pkg.repo}`, { headers });
  const lastCommitDays = repo?.pushed_at ? daysBetween(repo.pushed_at) : null;

  // Top contributors (first page, sorted by contributions) → top share.
  const contribs = await getJSON(
    `https://api.github.com/repos/${pkg.repo}/contributors?per_page=100&anon=false`,
    { headers },
  );
  let busFactor = null;
  if (Array.isArray(contribs) && contribs.length) {
    const counts = contribs.map((c) => c.contributions || 0);
    const total = counts.reduce((s, x) => s + x, 0);
    if (total > 0) {
      busFactor = { top_share: counts[0] / total, contributors: contribs.length };
    }
  }
  const repository = repo ? {
    stars: repo.stargazers_count ?? null,
    forks: repo.forks_count ?? null,
    open_issues: repo.open_issues_count ?? null,
    watchers: repo.subscribers_count ?? null,
    archived: Boolean(repo.archived),
    created_at: repo.created_at || null,
    pushed_at: repo.pushed_at || null,
    default_branch: repo.default_branch || null,
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 8) : [],
    source_url: repo.html_url || `https://github.com/${pkg.repo}`,
  } : null;
  return { last_commit_days: lastCommitDays, bus_factor: busFactor, repository };
}

// Gather all facts for one package. Any individual source may come back null;
// analyze.mjs lowers that sub-signal's confidence accordingly.
async function gatherFacts(pkg) {
  const [depsDev, vulns, eco, registry, gh] = await Promise.all([
    fetchDepsDev(pkg),
    fetchOSV(pkg),
    fetchEcosystems(pkg),
    fetchRegistry(pkg),
    fetchGitHub(pkg),
  ]);

  const maintenance = (eco || gh.last_commit_days != null) ? {
    last_release_days: eco?.last_release_days ?? null,
    last_commit_days: gh.last_commit_days,
    releases_past_year: eco?.releases_past_year ?? null,
  } : null;

  return {
    scorecard: depsDev.scorecard,
    vulns,
    maintenance,
    bus_factor: gh.bus_factor,
    github: gh.repository,
    registry,
    license: depsDev.license,
  };
}

// A package is "live enough" to publish only if we got the core signals — a
// scorecard or vuln read AND some license info. Otherwise we treat it as a
// failure and keep the committed sample for the whole dataset.
function hasUsableFacts(facts) {
  const haveSecurity = facts.scorecard != null || facts.vulns != null;
  return haveSecurity && (facts.license != null || facts.maintenance != null);
}

async function main() {
  const snapshotDate = isoDate(new Date());
  await mkdir(join(DATA_DIR, 'packages'), { recursive: true });

  // Build everything in memory first; only commit if EVERY package succeeds, so
  // a slow/failed ingest leaves the committed sample dataset fully intact.
  const built = [];
  for (const pkg of PACKAGES) {
    process.stdout.write(`Fetching ${pkg.displayName} (${pkg.ecosystem})… `);
    if (budgetLeft() <= 0) {
      throw new Error('time budget exhausted — keeping committed sample data');
    }
    const facts = await gatherFacts(pkg);
    if (!hasUsableFacts(facts)) {
      throw new Error(`insufficient live data for ${pkg.displayName} — keeping committed sample data`);
    }
    const pkgBuilt = buildPackage({
      slug: pkg.slug,
      name: pkg.name,
      displayName: pkg.displayName,
      ecosystem: pkg.ecosystem,
      repo: pkg.repo,
      dataSource: 'live',
      snapshotDate,
      facts,
    });
    built.push(pkgBuilt);
    console.log(`risk ${pkgBuilt.signal.score} (${pkgBuilt.signal.band})`);
  }

  // All good — commit every file.
  for (const b of built) {
    await writeFile(
      join(DATA_DIR, 'packages', `${b.slug}.json`),
      `${JSON.stringify(b, null, 2)}\n`,
    );
  }
  const index = {
    generated: snapshotDate,
    data_source: 'live',
    note: 'Live snapshot from public open-source APIs (deps.dev, OSV.dev, ecosyste.ms, GitHub, npm/PyPI, SPDX/OpenSSF). Signals are exploratory, not verdicts.',
    packages: built
      .map((b) => ({
        slug: b.slug,
        display_name: b.display_name,
        name: b.name,
        ecosystem: b.ecosystem,
        repo: b.repo,
        signal_score: b.signal.score,
        health_score: b.signal.health_score,
        signal_band: b.signal.band,
      }))
      .sort((a, b) => b.signal_score - a.signal_score),
  };
  await writeFile(join(DATA_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\nWrote ${built.length}/${PACKAGES.length} packages to ${DATA_DIR}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
