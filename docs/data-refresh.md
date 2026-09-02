# Data Refresh Workflow

Command:

```bash
npm run data:refresh
```

This is the single command for full refresh: topology hydration, media enrichment, diagnostics, and approved runtime publication.

Milestone 5 behavior:

1. Parse and validate `data/source/species-list.txt`.
2. Load targets through an isolated source adapter boundary.
3. Cache the source snapshot under `data/cache/` with a content hash.
4. Build a versioned artifact with diagnostics under `data/candidate/`.
5. Diff generated targets vs latest approved dataset when a baseline exists.
6. Write a machine-readable diff JSON and human-readable report markdown.
7. Publish the same dataset version to `data/approved/` on every successful refresh.

Milestone 6 additions:

1. OpenTree topology generation is required and runs before enrichment; refresh aborts if OpenTree placement or induced subtree retrieval is unavailable.
2. Unary low-confidence or `navigationOnly` internal nodes are pruned before publication.
3. Media/taxonomy enrichment runs over compiled tree endpoints with cache-first lookups.
4. Internal-node reconstructions are generated during refresh and attached as reconstruction assets.
5. Provider snapshots record requests/cache-hits/success/failure notes for auditing.
6. Artifacts include `mediaEnrichment` with:
	- `assetsById` licensed media records and attribution.
	- `nodeMediaByNodeId` primary asset mapping for runtime.
	- `reconstructionQueue` prompt manifests for generated internal/clade reconstructions.
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

- `npm run data:refresh` updates candidate diagnostics and approved runtime artifacts in one flow.
- If refresh fails, no approved artifact is modified.

Current scope note:

- Candidate and approved artifacts include a `scientificPhylogeny` payload consumed by the UI runtime loader.
- OpenTree topology is authoritative for runtime generation in this flow; unresolved and low-confidence unary internals are collapsed before publication.
- Online source adapters are best-effort and should be treated as enrichment candidates pending scientific review.
