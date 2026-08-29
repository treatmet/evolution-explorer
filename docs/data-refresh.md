# Data Refresh Workflow

Command:

```bash
npm run data:refresh
```

Online external enrichment mode:

```bash
npm run data:refresh:media
```

Promote latest candidate to approved:

```bash
npm run data:promote
```

Promote with online enrichment:

```bash
npm run data:promote:media
```

Milestone 5 behavior:

1. Parse and validate `data/source/species-list.txt`.
2. Load targets through an isolated source adapter boundary.
3. Cache the source snapshot under `data/cache/` with a content hash.
4. Build a versioned candidate dataset artifact under `data/candidate/`.
5. Diff candidate vs latest approved dataset when a baseline exists.
6. Write a machine-readable diff JSON and human-readable report markdown.
7. Keep approved artifacts untouched unless explicit promotion is requested.

Milestone 6 additions:

1. Media/taxonomy enrichment runs over compiled tree endpoints with cache-first lookups.
2. Provider snapshots record requests/cache-hits/success/failure notes for auditing.
3. Candidate artifacts include `mediaEnrichment` with:
	- `assetsById` licensed media records and attribution.
	- `nodeMediaByNodeId` primary asset mapping for runtime.
	- `reconstructionQueue` prompt manifests for internal/clade reconstructions pending review.
	- `targetDifficultyMetadata` familiarity hints used by runtime target sampling.

Output files:

- `data/cache/species-list-<timestamp>-<hash>.json`
- `data/candidate/dataset-YYYY.MM.DD.N.json`
- `data/candidate/latest.json`
- `data/candidate/diff-YYYY.MM.DD.N.json`
- `data/candidate/report-YYYY.MM.DD.N.md`

Runtime mirror files for the web app:

- `apps/web/public/data/candidate/latest.json`
- `apps/web/public/data/candidate/dataset-YYYY.MM.DD.N.json`
- `apps/web/public/data/approved/latest.json` (when available)
- `apps/web/public/data/approved/dataset-YYYY.MM.DD.N.json` (when available)

Promotion behavior:

- `npm run data:refresh` only updates candidate outputs.
- `npm run data:promote` writes the same dataset version into `data/approved/` with `validationStatus: "approved"` and updates `data/approved/latest.json`.
- If refresh fails, no approved artifact is modified.

Current scope note:

- Candidate and approved artifacts include a `scientificPhylogeny` payload consumed by the UI runtime loader.
- The current compiler builds a provisional large tree from all species-list targets using explicit `navigationOnly` internal nodes.
- This provisional topology is intentionally non-authoritative and avoids claiming resolved evolutionary relationships.
- Online source adapters are best-effort and should be treated as enrichment candidates pending scientific review.
