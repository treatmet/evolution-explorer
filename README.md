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

Runtime data behavior:

- `npm run data:refresh` is the single full refresh command. It hydrates topology + media and publishes both candidate diagnostics and runtime-approved artifacts.
- OpenTree topology is required. If OpenTree placement or induced subtree retrieval is unavailable, refresh fails fast instead of generating a fallback unresolved tree.
- Online provider lookups (OpenTree/GBIF/PBDB/iNaturalist/PhyloPic/Openverse) are part of the default refresh flow.
- The web app loads `apps/web/public/data/approved/latest.json` at startup and uses the approved artifact payload for runtime scientific data.
- Approved artifacts include `mediaEnrichment` payloads (resolved assets, node media mapping, provider snapshots, generated reconstruction assets for internal nodes, reconstruction queue records, and target familiarity metadata).
- Unary low-confidence or navigation-only internal nodes are pruned before publication.

This milestone includes the workflow shell, parser validation, domain algorithms, renderer contracts, source compiler workflow, and runtime dataset loading in the web app.
