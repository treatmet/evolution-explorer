# EVOLUTION-EXPLORER

Milestone 1 foundation for a scientifically grounded phylogenetic navigation game.

## Quick start

```bash
npm install
npm run build
npm test
npm run dev:web
```

## Data refresh entrypoint

```bash
npm run data:refresh
npm run dev:web


```
## APIs Used
| Provider               | Scope                        | Purpose and decisions                                                                                                  |
|------------------------|------------------------------|------------------------------------------------------------------------------------------------------------------------|
| OpenTree TNRS          | Every source target          | Rechecks OTT ID and canonical name; first approximate match wins.                                                      |
| GBIF Species Match     | Every source target          | Supplies canonical name, rank, usage key, and confidence. GBIF taxon ID takes precedence over OTT ID during enrichment. |
| Paleobiology Database  | Every source target          | Determines extinct status from `ext`/`extant`; uses `lma`/`lna`/`fma`/`fna` for extinction age.                        |
| iNaturalist Taxa       | Extant source targets        | Finds the first freely licensed default photo among up to three taxon results.                                         |
| PhyloPic               | Every source target          | Uses the first available silhouette, with low confidence.                                                              |
| Openverse              | Extinct source targets only  | Searches for commercial-use JPG paleoart or silhouettes; the first result with a URL wins.                             |
| Wikipedia REST Summary | Meaningful undescribed nodes | Supplies descriptions, capped at 500 characters without splitting sentences.                                          |



Runtime data behavior:

- `npm run data:refresh` is the single full refresh command. It hydrates topology + media and publishes both candidate diagnostics and runtime-approved artifacts.
- OpenTree topology is required. If OpenTree placement or induced subtree retrieval is unavailable, refresh fails fast instead of generating a fallback unresolved tree.
- Online provider lookups (OpenTree/GBIF/PBDB/iNaturalist/PhyloPic/Openverse) are part of the default refresh flow.
- The web app loads `apps/web/public/data/approved/latest.json` at startup and uses the approved artifact payload for runtime scientific data.
- Approved artifacts include `mediaEnrichment` payloads (resolved assets, node media mapping, provider snapshots, generated reconstruction assets for internal nodes, reconstruction queue records, and target familiarity metadata).
- Unary low-confidence or navigation-only internal nodes are pruned before publication.

This milestone includes the workflow shell, parser validation, domain algorithms, renderer contracts, source compiler workflow, and runtime dataset loading in the web app.
