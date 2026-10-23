# EVOLUTION-EXPLORER

Foundation for a scientifically grounded phylogenetic navigation game.

More detailed documentation found in /docs.

## Quick start

```bash
npm install
npm run build
npm test
npm run dev:web
```

## Data refresh entrypoint

```bash
npm run data
npm run dev:web


```
## APIs Used
| Provider               | Scope                        | Purpose and decisions                                                                                                  |
|------------------------|------------------------------|------------------------------------------------------------------------------------------------------------------------|
| OpenTree TNRS          | Every source target          | Rechecks OTT ID and canonical name; first approximate match wins.                                                      |
| GBIF Species Match     | Every source target          | Supplies canonical name, rank, usage key, and confidence. GBIF taxon ID takes precedence over OTT ID during enrichment. |
| Paleobiology Database  | Every source target          | Determines extinct status from `ext`/`extant`; uses `lma`/`lna`/`fma`/`fna` for extinction age.                        |
| Wikipedia + Commons    | All named non-navigation nodes | Primary descriptions and representative lead images, with per-file license checks. |
| iNaturalist Taxa       | Extant taxa and internal clades | Exact-name, commercial-compatible photo fallback. |
| PhyloPic               | Named nodes without a photo | Commercial-compatible silhouette fallback, with attribution and license metadata. |
| Openverse              | Extinct endpoints still without media | Commercial-compatible illustration fallback. |



Runtime data behavior:

- `npm run data` is the full refresh command. It reads scientific names only from `data/source/species-list.txt`, hydrates topology and presentation data, and publishes candidate diagnostics and runtime-approved artifacts. See [the data refresh reference](docs/data-refresh.md).
- OpenTree topology is required. If OpenTree placement or induced subtree retrieval is unavailable, refresh fails fast instead of generating a fallback unresolved tree.
- Online provider lookups (OpenTree/GBIF/PBDB/iNaturalist/PhyloPic/Openverse) are part of the default refresh flow.
- The web app loads `apps/web/public/data/approved/latest.json` at startup and uses the approved artifact payload for runtime scientific data.
- Approved artifacts include `mediaEnrichment` payloads (attributed assets, node media mapping, provider snapshots, target/intermediary coverage reports, structural placeholder records, and target familiarity metadata). Target and intermediary named nodes use the same Wikipedia-first hydration path.
- Unary low-confidence or navigation-only internal nodes are pruned before publication.

This milestone includes the workflow shell, parser validation, domain algorithms, renderer contracts, source compiler workflow, and runtime dataset loading in the web app.
