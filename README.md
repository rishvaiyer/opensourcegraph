# OpenSourceGraph

![OpenSourceGraph explorer](docs/preview.png)

> Transparent health/risk signals for open-source packages — built entirely on
> **public open-source APIs**: deps.dev, OSV.dev, ecosyste.ms, GitHub, and
> SPDX/OpenSSF.

Search an npm or PyPI package → see a **transparent 0–100 health/risk signal**
blended from five interpretable sub-signals, each shown with its weight, the
evidence behind it, its **named source**, and a **confidence label**. Compare
two packages side by side.

OpenSourceGraph is a **public-data signal explorer**, not a security audit, a
certification, or an endorsement of (or a warning against) any project. Every
score is labeled as an exploratory estimate, and low-confidence factors mean a
source was missing — not that a project is fine.

**Live:** https://rishva.up.railway.app/opensourcegraph/

**Original home:** https://unevil-warden.github.io/unevil/opensourcegraph/ — my earlier GitHub account (unevil-warden), since retired; kept here as provenance.

---

## What it shows

For each package in a curated set (well-known npm + PyPI libraries and repos):

- **Risk leaderboard** — packages ranked by an exploratory 0–100 risk signal
  (highest first: "where to look closer"), with a paired health score.
- **Transparent health/risk signal** — a 0–100 score blended from five
  interpretable sub-signals, each shown with its weight, evidence, source, and
  confidence:
  | Sub-signal | Weight | Source | What it measures |
  |---|---|---|---|
  | Security posture | 0.25 | OpenSSF Scorecard (via deps.dev) | Scorecard 0–10, inverted to risk |
  | Known vulnerabilities | 0.25 | OSV.dev | Advisory count + max severity |
  | Maintenance / activity | 0.20 | ecosyste.ms / GitHub | Release & commit recency, release cadence |
  | Bus-factor | 0.15 | GitHub contributors | Top-contributor commit share |
  | License risk | 0.15 | SPDX id (local classification) | Permissive vs copyleft vs unknown |
- **At-a-glance KPIs** — Scorecard, known vulns, days since release, top
  contributor share.
- **Plain-English summary** — generated deterministically from the computed
  signal. No LLM, no fabricated claims.

All factors are in **risk-direction** (higher = more reason to look closer). The
health reading is simply `100 − risk`, which the UI also surfaces.

---

## Architecture

A deliberately small, static, dependency-free app — same shape as the rest of
the portfolio (see `complaintgraph/`):

```
opensourcegraph/
  src/                  # the dashboard (published as-is)
    index.html
    app.js              # vanilla JS, inline-SVG gauge, zero dependencies
    styles.css          # shared portfolio design tokens (dark, Space Grotesk/Mono, green accent)
  scripts/
    lib/analyze.mjs     # single source of truth: facts -> per-package signal + summary
    ingest.mjs          # fetch live open-source API data, bake to data/*.json (bounded + fallback)
    gen-sample.mjs      # deterministic, clearly-labeled SAMPLE data (same analyzer)
  data/                 # baked JSON the dashboard reads (committed sample; overwritten by live ingest in CI)
    index.json
    packages/*.json
  build-site.mjs        # assemble src/ + data/ into dist/ for local preview
```

The page reads only static JSON — there are **no runtime API calls** and no
backend. Data is baked at build time. In CI the live ingest runs and overwrites
`data/`; if it fails, the committed sample data is kept and clearly labeled in
the UI.

---

## Sample vs live modes

`analyze.mjs` is the single source of truth, so the sample and live datasets are
byte-for-byte the same shape:

- **Sample** (`npm run sample`) — deterministic, fully **offline** synthetic
  facts, shaped to resemble real profiles (e.g. `react`/`numpy` score well on
  security and maintenance; `left-pad` scores poorly on maintenance and
  bus-factor; `lodash` is elevated by staleness and a known advisory). Clearly
  labeled `SAMPLE` in the UI badge.
- **Live** (`npm run ingest`) — pulls real metadata from the public APIs below.
  The ingest is **bounded** exactly like ComplaintGraph's CFPB ingest: every
  request has an `AbortController` timeout, the whole run has a wall-clock
  budget, and it only writes to disk if **every** package succeeds. Any failure
  (slow API, offline sandbox, rate limit) logs and leaves the committed sample
  data fully intact, so the page always renders.

---

## Run it locally

Requires Node 18+. No install step, no API key.

```bash
cd opensourcegraph

# regenerate the labeled sample dataset (fully offline)
npm run sample

# (optional) pull a live snapshot from the open-source APIs (needs internet)
#   GITHUB_TOKEN is optional and only raises the GitHub rate limit.
npm run ingest

# build + serve at http://localhost:5070
npm run preview
```

Then open http://localhost:5070. Serve over HTTP rather than opening
`index.html` directly — browsers block `fetch()` of local files over `file://`.

---

## Data sources

All public, open, and key-free (GITHUB_TOKEN is optional, rate-limit only):

- **[deps.dev](https://deps.dev/)** — package licenses, advisories, and the
  OpenSSF Scorecard overall score.
- **[OSV.dev](https://osv.dev/)** — known vulnerabilities (`POST /v1/query`).
- **[ecosyste.ms](https://ecosyste.ms/)** — registry/repo maintenance metadata.
- **[GitHub REST](https://docs.github.com/rest)** — last commit (`pushed_at`)
  and contributor concentration for the bus-factor signal.
- **[npm downloads API](https://api.npmjs.org/)** / **[pypistats.org](https://pypistats.org/)** —
  monthly download counts, shown as an adoption KPI (context only, not part of the risk signal).
- **[SPDX](https://spdx.org/licenses/)** / **[OpenSSF Scorecard](https://securityscorecards.dev/)**
  — license ids classified locally; Scorecard scores read via deps.dev.

No OAuth, no scraping, no personal data.

---

## How it plugs into the portfolio

OpenSourceGraph is a sibling of `complaintgraph/` under the same unEvilGenius
Labs umbrella: same static, no-backend architecture; same dark visual language
(Space Grotesk/Space Mono, green accent); same "honest about estimates" ethos —
a transparent signal explorer that always shows its work and never issues a
verdict. The root portfolio page links to it like the other projects, and CI
assembles it under `_site/opensourcegraph/`.

---

## Honest limits

- A health/risk **score is not a verdict.** It is a heuristic for "where to look
  closer," not a measure of quality, safety, or trustworthiness.
- **License classification is coarse.** Copyleft is not "worse" — it simply
  carries more obligations to weigh before adopting. Composite expressions are
  read by their first id.
- **Bus-factor** uses GitHub's first contributors page; very large projects'
  long tails are approximated.
- **Low confidence** on a factor means a source was missing or unparseable — it
  lowers certainty, not the project's standing.
- Sample data is synthetic and labeled as such; it exists only so the page
  renders before/without a live ingest.
