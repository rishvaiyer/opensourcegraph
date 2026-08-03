// OpenSourceGraph — sample dataset generator.
//
// Produces a deterministic, clearly-labeled SAMPLE dataset so the dashboard
// renders locally and on GitHub Pages even before/without a live ingest.
// Numbers are synthetic but shaped to resemble real open-source health profiles
// (well-maintained libraries like react score well on security/maintenance;
// abandoned single-author packages like left-pad score poorly on maintenance
// and bus-factor).
//
// Real data, when ingested in CI, overwrites these files. Nothing here is a
// verdict about or an endorsement of any project — every number is a signal.
//
// Usage: node scripts/gen-sample.mjs   (fully offline, no network)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPackage, PACKAGES } from './lib/analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

// Deterministic RNG (mulberry32) seeded per package — reproducible builds.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Per-package archetypes describing the *shape* of plausible facts. A small
// per-field jitter (via the seeded RNG) keeps numbers from looking hand-set
// while staying fully deterministic across machines.
//   health: well-maintained, multi-contributor, permissive, no known vulns.
//   abandoned: stale, single-author — high maintenance + bus-factor risk.
//   busy: actively maintained but with a recent advisory (real-world common).
const ARCHETYPES = {
  react: { scorecard: 9.0, vulns: 0, sev: null, relDays: 40, commitDays: 1, cadence: 14, topShare: 0.18, contribs: 1600, spdx: 'MIT' },
  lodash: { scorecard: 6.3, vulns: 1, sev: 'HIGH', relDays: 900, commitDays: 120, cadence: 1, topShare: 0.62, contribs: 320, spdx: 'MIT' },
  express: { scorecard: 7.1, vulns: 0, sev: null, relDays: 120, commitDays: 9, cadence: 6, topShare: 0.34, contribs: 280, spdx: 'MIT' },
  'left-pad': { scorecard: 2.4, vulns: 0, sev: null, relDays: 3400, commitDays: 3300, cadence: 0, topShare: 0.94, contribs: 3, spdx: 'WTFPL' },
  chalk: { scorecard: 6.8, vulns: 0, sev: null, relDays: 210, commitDays: 60, cadence: 3, topShare: 0.48, contribs: 60, spdx: 'MIT' },
  requests: { scorecard: 8.2, vulns: 1, sev: 'MODERATE', relDays: 200, commitDays: 14, cadence: 4, topShare: 0.41, contribs: 700, spdx: 'Apache-2.0' },
  flask: { scorecard: 8.0, vulns: 0, sev: null, relDays: 150, commitDays: 7, cadence: 5, topShare: 0.36, contribs: 700, spdx: 'BSD-3-Clause' },
  numpy: { scorecard: 8.6, vulns: 0, sev: null, relDays: 60, commitDays: 1, cadence: 9, topShare: 0.12, contribs: 1500, spdx: 'BSD-3-Clause' },
  urllib3: { scorecard: 8.4, vulns: 1, sev: 'MODERATE', relDays: 90, commitDays: 5, cadence: 6, topShare: 0.29, contribs: 350, spdx: 'MIT' },
};

// Jitter a base value by ±frac, deterministically, keeping it sane.
function jitter(rand, base, frac, min = 0) {
  const delta = (rand() * 2 - 1) * frac * base;
  return Math.max(min, Math.round(base + delta));
}

function makeFacts(pkg, rand) {
  const a = ARCHETYPES[pkg.slug];
  return {
    scorecard: { score: Math.round((a.scorecard + (rand() * 2 - 1) * 0.3) * 10) / 10 },
    vulns: { count: a.vulns, max_severity: a.sev },
    maintenance: {
      last_release_days: jitter(rand, a.relDays, 0.15),
      last_commit_days: jitter(rand, a.commitDays, 0.3),
      releases_past_year: a.cadence,
    },
    bus_factor: {
      top_share: Math.min(0.99, Math.max(0.05, Math.round((a.topShare + (rand() * 2 - 1) * 0.05) * 100) / 100)),
      contributors: jitter(rand, a.contribs, 0.05, 1),
    },
    license: { spdx_id: a.spdx },
  };
}

async function main() {
  const snapshotDate = '2026-06-29'; // fixed so sample output is deterministic
  await mkdir(join(DATA_DIR, 'packages'), { recursive: true });

  const indexEntries = [];
  for (const pkg of PACKAGES) {
    const rand = rng(seedFrom(pkg.slug));
    const facts = makeFacts(pkg, rand);
    const built = buildPackage({
      slug: pkg.slug,
      name: pkg.name,
      displayName: pkg.displayName,
      ecosystem: pkg.ecosystem,
      repo: pkg.repo,
      dataSource: 'sample',
      snapshotDate,
      facts,
    });
    await writeFile(
      join(DATA_DIR, 'packages', `${pkg.slug}.json`),
      `${JSON.stringify(built, null, 2)}\n`,
    );
    indexEntries.push({
      slug: pkg.slug,
      display_name: pkg.displayName,
      name: pkg.name,
      ecosystem: pkg.ecosystem,
      repo: pkg.repo,
      signal_score: built.signal.score,
      health_score: built.signal.health_score,
      signal_band: built.signal.band,
    });
    console.log(`${pkg.displayName} (${pkg.ecosystem}): risk ${built.signal.score} (${built.signal.band}), health ${built.signal.health_score}`);
  }

  const index = {
    generated: snapshotDate,
    data_source: 'sample',
    note: 'SAMPLE data — synthetic, for demo only. Replaced by live open-source API data when ingested in CI.',
    // Highest risk first, so the leaderboard reads like "where to look closer".
    packages: indexEntries.sort((a, b) => b.signal_score - a.signal_score),
  };
  await writeFile(join(DATA_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\nWrote ${PACKAGES.length} sample packages to ${DATA_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
