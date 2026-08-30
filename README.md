# EVO-TREE

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
npm run data:promote
npm run data:refresh:media -- --progress-interval-percent=5
npm run data:promote:media
npm run dev:web


```

Runtime data behavior:

- `npm run data:refresh` writes candidate/cache artifacts and mirrors them into `apps/web/public/data/candidate`.
- `npm run data:promote` additionally updates `data/approved` and mirrors `apps/web/public/data/approved`.
- `npm run data:refresh:media` enables online provider lookups (OpenTree/GBIF/PBDB/iNaturalist/PhyloPic/Openverse) with cache-first behavior for Milestone 6 enrichment.
- `npm run data:promote:media` performs online enrichment and promotes the resulting approved artifact.
- The web app loads `apps/web/public/data/approved/latest.json` at startup and uses the approved artifact payload for runtime scientific data.
- Approved artifacts now include `mediaEnrichment` payloads (resolved assets, node media mapping, provider snapshots, reconstruction queue manifest, and target familiarity metadata).
- The current compiled runtime tree is generated from all species-list targets using explicit navigation-only internal branches until authoritative topology adapters are integrated.

This milestone includes the workflow shell, parser validation, domain algorithms, renderer contracts, source compiler workflow, and runtime dataset loading in the web app.
