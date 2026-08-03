// OpenSourceGraph — shared analysis library.
//
// Single source of truth used by BOTH the live ingest and the sample-data
// generator, so live and sample datasets always have an identical shape.
//
// Input: a normalized per-package "facts" object describing what the public
// open-source APIs returned (or, for sample data, plausible synthetic values).
// All fields are optional — when a source is missing we lower the confidence of
// the affected sub-signal rather than inventing a number.
//
//   facts = {
//     scorecard:   { score: 0..10 } | null,        // OpenSSF Scorecard (deps.dev)
//     vulns:       { count, max_severity } | null,  // OSV.dev advisories
//     maintenance: {                                // ecosyste.ms / GitHub
//       last_release_days: number,                  // days since last release
//       last_commit_days:  number,                  // days since last commit
//       releases_past_year: number,                 // release cadence
//     } | null,
//     bus_factor:  { top_share, contributors } | null, // GitHub contributors
//     license:     { spdx_id: string } | null,         // SPDX id (deps.dev / ecosyste.ms)
//   }
//
// Output: a per-package object (see buildPackage) that the static dashboard
// renders directly. Everything here is deterministic — no randomness, no
// network, no LLM. Any inferred number is labeled as an exploratory SIGNAL with
// a named source and a confidence label, never stated as a verdict about or an
// endorsement of a project.

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// License classification. We keep a small, local SPDX map (no network) and bin
// each id into permissive / weak-copyleft / strong-copyleft / unknown. This is
// a coarse risk lens — copyleft is not "bad", it just carries more obligations,
// so we surface it as a signal, not a verdict.
// ---------------------------------------------------------------------------
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

// Classify an SPDX id → { class, risk } where risk is 0..100 in risk-direction
// (higher = more obligation/uncertainty to look closer at before adopting).
function classifyLicense(spdxId) {
  const id = (spdxId || '').trim();
  if (!id) return { class: 'unknown', risk: 70, label: 'No declared license' };
  // Take the first id in any composite expression (e.g. "MIT OR Apache-2.0").
  const head = id.split(/\s+(?:OR|AND|WITH)\s+/i)[0].trim();
  if (PERMISSIVE.has(head)) return { class: 'permissive', risk: 5, label: `${id} (permissive)` };
  if (WEAK_COPYLEFT.has(head)) return { class: 'weak-copyleft', risk: 35, label: `${id} (weak copyleft)` };
  if (STRONG_COPYLEFT.has(head)) return { class: 'strong-copyleft', risk: 60, label: `${id} (strong copyleft)` };
  return { class: 'unknown', risk: 55, label: `${id} (unrecognized)` };
}

// Map an OSV severity word to a 0..100 risk contribution.
function severityRisk(word) {
  return { CRITICAL: 100, HIGH: 80, MODERATE: 55, MEDIUM: 55, LOW: 30 }[(word || '').toUpperCase()] || 50;
}

// ---------------------------------------------------------------------------
// Risk signal. A transparent 0–100 score built from interpretable sub-signals,
// each in RISK-direction (higher = more reason to look closer before relying on
// the package). The breakdown (value + weight + evidence + source + confidence)
// is shown in the UI so nothing is a black box. A health-direction reading is
// just 100 − score, which the UI also surfaces.
// ---------------------------------------------------------------------------
function computeSignal(facts) {
  const components = [];

  // 1. Security posture — from OpenSSF Scorecard (0..10, higher = better). We
  // invert to risk-direction. Missing scorecard is excluded, never imputed.
  {
    const sc = facts.scorecard;
    let value;
    let evidence;
    let confidence;
    if (sc && typeof sc.score === 'number') {
      value = round(clamp((10 - sc.score) / 10, 0, 1) * 100, 1);
      evidence = `OpenSSF Scorecard ${round(sc.score, 1)}/10 → inverted to ${value}/100 risk`;
      confidence = 'high';
    } else {
      value = null;
      evidence = 'no OpenSSF Scorecard returned — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({
      key: 'security_posture', label: 'Security posture', weight: 0.25,
      value, evidence, source: 'OpenSSF Scorecard (via deps.dev)', confidence,
    });
  }

  // 2. Known vulnerabilities — advisories associated with the package across
  // versions, not a claim about a particular installed version.
  {
    const v = facts.vulns;
    let value;
    let evidence;
    let confidence;
    if (v && typeof v.count === 'number') {
      if (v.count === 0) {
        value = 0;
        evidence = 'no package advisories returned by OSV';
      } else {
        const base = severityRisk(v.max_severity);
        // Each additional advisory adds a little, capped at the base ceiling.
        value = round(clamp(base * (0.7 + 0.3 * Math.min(1, v.count / 5)), 0, 100), 1);
        evidence = `${v.count} package advisor${v.count === 1 ? 'y' : 'ies'} across versions in OSV (max severity ${v.max_severity || 'unknown'})`;
      }
      confidence = 'high';
    } else {
      value = null;
      evidence = 'OSV lookup unavailable — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({
      key: 'known_vulns', label: 'Known vulnerabilities', weight: 0.25,
      value, evidence, source: 'OSV.dev', confidence,
    });
  }

  // 3. Maintenance / activity — recency of last release/commit and release
  // cadence. Stale projects score higher risk. Blends three sub-readings.
  {
    const m = facts.maintenance;
    let value;
    let evidence;
    let confidence;
    if (m) {
      // Days-since maps to risk via a soft ramp: <30d ~ 0, ~365d ~ 80, >2y ~ 100.
      const staleness = (days) => clamp((days / 365) * 80, 0, 100);
      const relStale = m.last_release_days != null ? staleness(m.last_release_days) : null;
      const commitStale = m.last_commit_days != null ? staleness(m.last_commit_days) : null;
      // Cadence: 0 releases/yr is risky, ~12/yr is healthy.
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
    components.push({
      key: 'maintenance', label: 'Maintenance / activity', weight: 0.20,
      value, evidence, source: 'ecosyste.ms / GitHub', confidence,
    });
  }

  // 4. Bus-factor — contributor concentration. If one person authored most
  // commits, continuity risk is higher. top_share is 0..1.
  {
    const b = facts.bus_factor;
    let value;
    let evidence;
    let confidence;
    if (b && typeof b.top_share === 'number') {
      // 0.2 share ~ low risk, 0.9+ share ~ high risk.
      value = round(clamp((b.top_share - 0.2) / 0.7, 0, 1) * 100, 1);
      evidence = `top contributor authored ${round(b.top_share * 100)}% of commits` +
        (b.contributors != null ? ` across ${b.contributors} contributors` : '');
      confidence = b.contributors != null && b.contributors >= 5 ? 'high' : 'medium';
    } else {
      value = null;
      evidence = 'contributor breakdown unavailable — excluded from the combined signal';
      confidence = 'low';
    }
    components.push({
      key: 'bus_factor', label: 'Bus-factor (contributor concentration)', weight: 0.15,
      value, evidence, source: 'GitHub contributors', confidence,
    });
  }

  // 5. License risk — permissive vs copyleft vs unknown, via SPDX id. Copyleft
  // is not "worse", it simply carries more obligations to weigh — surfaced as a
  // signal, never an endorsement or condemnation.
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

  const available = components.filter((component) => typeof component.value === 'number');
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
  const score = availableWeight
    ? round(available.reduce((sum, component) => sum + component.value * component.weight, 0) / availableWeight)
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

// Deterministic plain-English summary built only from the computed signal.
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

// Build the full per-package object from normalized facts.
export function buildPackage({ slug, name, displayName, ecosystem, repo, dataSource, snapshotDate, facts }) {
  const signal = computeSignal(facts);
  const summary = buildSummary(displayName, facts, signal);
  return {
    slug,
    name,
    display_name: displayName,
    ecosystem,
    repo: repo || null,
    data_source: dataSource,
    snapshot_date: snapshotDate,
    facts,
    signal,
    summary,
  };
}

// The curated set of well-known packages / repos the MVP covers, across
// ecosystems. `name` is the exact registry name; `repo` is "owner/name" on
// GitHub (used by the live ingest for contributor / activity metadata).
export const PACKAGES = [
  { slug: 'react', displayName: 'react', name: 'react', ecosystem: 'npm', repo: 'facebook/react' },
  { slug: 'lodash', displayName: 'lodash', name: 'lodash', ecosystem: 'npm', repo: 'lodash/lodash' },
  { slug: 'express', displayName: 'express', name: 'express', ecosystem: 'npm', repo: 'expressjs/express' },
  { slug: 'left-pad', displayName: 'left-pad', name: 'left-pad', ecosystem: 'npm', repo: 'left-pad/left-pad' },
  { slug: 'chalk', displayName: 'chalk', name: 'chalk', ecosystem: 'npm', repo: 'chalk/chalk' },
  { slug: 'requests', displayName: 'requests', name: 'requests', ecosystem: 'pypi', repo: 'psf/requests' },
  { slug: 'flask', displayName: 'flask', name: 'flask', ecosystem: 'pypi', repo: 'pallets/flask' },
  { slug: 'numpy', displayName: 'numpy', name: 'numpy', ecosystem: 'pypi', repo: 'numpy/numpy' },
  { slug: 'urllib3', displayName: 'urllib3', name: 'urllib3', ecosystem: 'pypi', repo: 'urllib3/urllib3' },
];

export { clamp, round, classifyLicense, severityRisk };
