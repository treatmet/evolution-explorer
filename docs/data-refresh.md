# Data Refresh (`npm run data`)

This document describes everything that happens when you run `npm run data` from the repository root. It is written for new developers and for AI models that need a reference for how the scientific dataset is produced.

## 1. Purpose

Evolution Explorer is a web app that lets people explore the evolutionary history of life as a navigable tree. The tree starts at the Last Universal Common Ancestor (LUCA) and branches out to a curated list of target species (for example, humans, zebrafish, and a bacterium). Each node in the tree needs a name, a description, sometimes a picture, and a position in a real phylogeny.

The web app does not build that data itself. It reads pre-built JSON files from `apps/web/public/data/approved/`. `npm run data` is the job that builds those files. It:

1. Reads the target species list.
2. Looks up each species in public scientific databases (OpenTree, GBIF, Paleobiology Database, iNaturalist, Wikipedia, PhyloPic, and Openverse).
3. Assembles a single phylogenetic tree from the results.
4. Attaches names, descriptions, media, and reconstructed-lineage placeholders to each node.
5. Writes a candidate dataset, compares it with the last approved dataset, and, only if everything succeeds, publishes it as the new approved dataset.

The result is a versioned, self-describing JSON artifact that the web app loads at startup and renders graphically.

## 2. How to run it

| Command | What it does |
|---|---|
| `npm run data` | Full refresh. Calls external APIs for any lookup that is not already cached on disk, then builds, diffs, and publishes. This is the only supported entry point. |
| `npm run data -- --media-target-limit=20` | Same as above, but media and description enrichment is limited to the first 20 targets. Useful for a faster test run. |
| `npm run data -- --media-timeout-ms=15000 --media-retries=3` | Tunes the per-request timeout and retry count for media lookups. |
| `npm run data -- --description-max-chars=300` | Limits the length of each node description. The default is 500. |
| `npm run data -- --progress-interval-percent=10` | Changes how often progress lines are printed. The default is 5. |

Flags are read from the command line first. npm also converts `--flag-name` into the `npm_config_flag_name` environment variable, and that is used as a fallback.

The root script already passes `--progress --progress-interval-percent=5 --description-max-chars=500`. Those defaults can be overridden by appending flags after `--`.

### Cache and offline behavior

- **Caching is automatic and always on.** Every external lookup is first checked against the on-disk cache under `data/cache/`. A cache hit is used without a network call. There is no expiry, so cached entries are used indefinitely.
- **There is no CLI flag to refresh or bypass the cache.** To force fresh lookups for a given provider or species, delete the matching files under `data/cache/external-topology/` or `data/cache/external-media/`, then run `npm run data`. The next run calls the APIs again for anything that is missing.
- **There is no CLI flag to run offline.** The pipeline has an offline mode internally. In offline mode, a cache miss returns "no result" without a network call. However, the CLI always sets online mode. The `--media-online` flag in `scripts/data-refresh/package.json` has no effect, because `scripts/data-refresh/src/index.ts` hardcodes `mediaOnline: true`.
- **Changing the species list.** The pipeline reads only `data/source/species-list.txt`. The files `species-list-small.txt` (11 targets) and `species-list-full.txt` (about 1000 rows) are not selected automatically. To use one, copy it over `species-list.txt` before running.

## 3. Where the code lives

| Piece | Location |
|---|---|
| Root command | `package.json` (`data` script) |
| CLI entry point | `scripts/data-refresh/src/index.ts` |
| Pipeline orchestration | `packages/scientific-data/src/compiler/refreshPipeline.ts` |
| Species list parser | `packages/scientific-data/src/parsing/parseSpeciesList.ts` |
| OpenTree topology builder | `packages/scientific-data/src/compiler/buildOpenTreeScientificPhylogeny.ts` |
| Unary-node pruning | `packages/scientific-data/src/compiler/pruneLowConfidenceUnaryNodes.ts` |
| Media, taxonomy, and description enrichment | `packages/scientific-data/src/media/enrichMedia.ts` |
| Name normalization | `packages/scientific-data/src/naming/normalizeNodeNames.ts` |
| Shared types | `packages/scientific-data/src/compiler/types.ts` |

## 4. Pipeline overview

The steps below run in this order. Each one notes what it calls, where its output goes, and whether that output is kept on disk or only in memory.

| # | Step | External calls | Output location |
|---|---|---|---|
| 1 | Prepare directories | None | Creates `data/cache`, `data/candidate`, `data/approved` |
| 2 | Parse species list | None | In memory |
| 3 | Assign dataset version | None | In memory |
| 4 | Save source snapshot | None | `data/cache/species-list-<timestamp>-<hash>.json` |
| 5 | Load baseline | None | In memory (read from `data/approved/`) |
| 6 | Build topology (OpenTree) | TNRS, induced subtree | In memory; lookups cached |
| 7 | Prune unary nodes | None | In memory |
| 8 | Write topology report | None | `data/candidate/topology-resolution-<v>.json` |
| 9 | Enrich media and taxonomy | GBIF, OpenTree, PBDB, iNaturalist, PhyloPic, Openverse, Wikipedia | In memory; lookups cached |
| 10 | Normalize names | None | In memory |
| 11 | Write candidate dataset | None | `data/candidate/dataset-<v>.json`, `data/candidate/latest.json` |
| 12 | Diff against baseline | None | `data/candidate/diff-<v>.json`, `data/candidate/report-<v>.md` |
| 13 | Publish approved dataset | None | `data/approved/dataset-<v>.json`, then `data/approved/latest.json` |
| 14 | Mirror to web app | None | Copies to `apps/web/public/data/` |

### Step 1: Prepare directories

The run creates `data/cache/`, `data/candidate/`, and `data/approved/` if they do not exist.

### Step 2: Parse the species list

Input: `data/source/species-list.txt`.

- The first non-empty line must match the header exactly: `Scientific name | Common name | Brief descriptor`.
- Each following line must have three pipe-separated fields. Each field must be non-empty after trimming.
- A stable `id` is derived from the scientific name. It is lowercased, and runs of non-alphanumeric characters become `-`. For example, `Homo sapiens` becomes `homo-sapiens`.
- Duplicate ids are rejected.
- Bad rows do not stop the run. They are recorded as "row issues" and written to the topology report in step 8. If no valid rows remain, the run fails.

The result is an in-memory list of targets. The current list has 11 targets, including Homo sapiens, Pan troglodytes, Tyrannosaurus rex, Danio rerio, and Bdellovibrio bacteriovorus.

### Step 3: Assign a dataset version

Versions look like `YYYY.MM.DD.N`, using the current UTC date. `N` is one more than the highest sequence already present for that date in `data/candidate/` and `data/approved/`. The version is kept in memory and used in every output filename below.

### Step 4: Save a source snapshot

The full parsed species list, along with a content hash, is written to:

`data/cache/species-list-<ISO timestamp with ':' and '.' replaced by '-'>-<first 12 chars of SHA-256>.json`

Example: `data/cache/species-list-2026-10-22T00-57-11-300Z-ead904351e4c.json`

This records exactly which input produced the dataset. The hash is the same across runs when the list has not changed.

### Step 5: Load the baseline

The pipeline reads `data/approved/latest.json` and then the dataset file it points to. This is the previously published dataset. It is used only for the diff in step 12. If no pointer exists, the pipeline uses the last `dataset-*.json` in `data/approved/` by name.

### Step 6: Build the topology (OpenTree)

This step builds the tree structure. It uses the **Open Tree of Life** (OpenTree), which provides a synthesized phylogeny with stable taxon identifiers called OTT ids.

**6a. Name resolution (TNRS).** For each target, the pipeline sends one request:

- `POST https://api.opentreeoflife.org/v3/tnrs/match_names`
- Body: `{ names: [<scientific name>], include_suppressed: false, do_approximate_matching: true }`
- Requests are sent one at a time.
- Each target ends with one status: `matched` (has an OTT id), `unmatched` (no match), `lookup-failed` (the request failed), or `skipped-offline`.
- Results are cached under `data/cache/external-topology/open-tree-tnrs/`.
- The run needs at least two resolved targets, or it fails.

**6b. Induced subtree.** The pipeline asks OpenTree for the minimal tree that connects all matched OTT ids:

- `POST https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree`
- Body: `{ ott_ids: [<sorted unique OTT ids>] }`
- Result is cached under `data/cache/external-topology/open-tree-induced-subtree/`.
- If the single request fails, the pipeline splits the ids in half and retries each half, recursively. Chunks of four or fewer ids are abandoned. Relationships between abandoned chunks are lost, and a warning is recorded. The report field `usedAdaptiveChunking` shows whether this happened.
- The response is a Newick string (a text format for trees). It is parsed in memory.

**6c. Build in-memory tree.** The pipeline turns the Newick tree into nodes:

- The root node has id `luca`, is labeled LUCA, and is assigned an age of 3,900 million years. Its confidence is `medium`.
- Ages for internal nodes are estimated from their depth in the tree. These are approximations, not measured dates.
- Targets that OpenTree could not place are attached under a separate branch with id `target-catalog-root`.
- Large internal groups are split into navigation sub-nodes so that no navigation node has more than six children. These are marked `navigationOnly`.

Output: an in-memory tree. Nothing is written to disk in this step except the cached HTTP responses.

### Step 7: Prune unary nodes

A unary node is an internal node with exactly one child. The pruner removes unary internal nodes whose confidence is `navigationOnly`, `low`, or `unresolved`. It never removes a target or a game endpoint. Output is in memory.

### Step 8: Write the topology report

`data/candidate/topology-resolution-<v>.json` records:

- Endpoint names used for the start and end of the game path (`nameResolution`, `inducedSubtree`).
- Summary counts: `totalTargets`, `matched`, `unmatched`, `lookupFailed`, `skippedOffline`, `placedInTopology`, `inducedSubtreeChunkCount`, `usedAdaptiveChunking`.
- Per-target resolution status.
- Source row issues from step 2.

A recent run recorded: 11 targets, 11 matched, 11 placed, 1 induced-subtree chunk, no adaptive chunking.

### Step 9: Enrich media, taxonomy, and descriptions

This is the largest step. For each target and each node in the tree, the pipeline gathers taxonomy, media, and descriptions. Progress is logged by phase (`target-media`, then `node-descriptions`).

**Taxonomy (per target, three lookups in parallel):**

| Provider | Request | Result |
|---|---|---|
| GBIF | `GET https://api.gbif.org/v1/species/match?name=<name>` | GBIF key, becomes `taxonId` `gbif:<key>` |
| OpenTree | Same TNRS endpoint as step 6a | Becomes `taxonId` `ott:<id>` when GBIF has no key |
| Paleobiology Database | `GET https://paleobiodb.org/data1.2/taxa/list.json?name=<name>&show=attr` | If the taxon looks extinct, sets `extant=false` and `extinctionAgeMa` |

**Media candidates:**

- **Extant nodes:** iNaturalist taxa search, `GET https://api.inaturalist.org/v1/taxa?q=<name>&per_page=3&is_active=true`. Only photos with a free license code are kept. The first usable photo wins.
- **All nodes:** PhyloPic silhouette search, `GET https://api.phylopic.org/images?filter_name=<name>`. Confidence is `low`, license is `varies`.
- **Extinct nodes:** Openverse image search, `GET https://api.openverse.engineering/v1/images/?q=<name> paleoart silhouette&license_type=commercial&extension=jpg&page_size=5`. These candidates are placed first.

Each asset gets an id of the form `<kind>-<nodeId>-<12-char hash>`. The chosen primary asset per node is tracked in memory.

**Descriptions (per node):**

- Wikipedia summary: `GET https://en.wikipedia.org/api/rest_v1/page/summary/<title>`. The pipeline tries several title variants (plain name, raw name, `(genus)`, `(biology)`). Disambiguation pages are rejected.
- Lead links: `GET https://en.wikipedia.org/w/api.php?action=parse&prop=text&section=0&redirects=1&format=json&formatversion=2&page=<title>`. The HTML of the lead section is scanned for links to other articles. These links become inline `descriptionSegments` so the web app can link words inside a description.
- Descriptions are trimmed to whole sentences within `--description-max-chars` (default 500).
- If two nested clades resolve to the same article, the description is kept only for the closer node. This avoids misattributing one description to several nodes.
- Nodes without a usable description get generated lineage text at display time.

**Reconstructions (per internal node):** Every node that has children gets a `reconstruction` entry. The image is a locally generated inline SVG (title and subtitle on a gradient). No external image-generation service is called. The review status is `generated`. Confidence is `speculative` for navigation nodes and `low` for others.

**Difficulty metadata:** Each target gets a `familiarity` score from a keyword heuristic on its brief descriptor. Values are 0.92, 0.55, 0.3, or 0.25. No API is called.

**Provider statistics:** For each provider, the pipeline records request count, cache hits, successes, failures, and notes. These are stored in `media.providerSnapshots` in the dataset.

**Media limit:** By default every target is processed. `--media-target-limit=N` restricts this, and a warning is added to the report when a limit is in effect.

Output: all taxonomy, media, and description data is held in memory and written only as part of the candidate and approved datasets in steps 11 and 13. There is no separate media file on disk. The raw HTTP responses are cached as described below.

### Step 10: Normalize names

This step is offline. It produces three name forms for each node: singular, plural, and clade.

- Seed targets keep their curated common name in all forms (for example, "Zebrafish").
- Three fixed overrides apply: LUCA, Bacteria (singular "Bacterium"), and Archaea (singular "Archaeon").
- Otherwise, the name comes from the Wikipedia article's vernacular title when it is English. If the title is a Latin taxon name, a morphology rule derives an English form (for example, "Carnivora" becomes "carnivoran"). Plurals use simple English pluralization rules.
- Placeholder labels such as `MRCA ...`, `H123`, and `OpenTree clade ...` do not get their own names. They are left for runtime compaction.
- If two siblings end up with the same singular name, both revert to clade names and a warning is recorded.

Output: in memory.

### Step 11: Write the candidate dataset

- `data/candidate/dataset-<v>.json`: the full artifact. It has a manifest with status `candidate`, the targets, the tree, the topology metadata, the media enrichment data, and the provider statistics. The tree's version is suffixed with `+media`.
- `data/candidate/latest.json`: a small pointer (`datasetVersion`, `fileName`, `generatedAt`).

### Step 12: Diff against the baseline

The pipeline compares the candidate targets with the baseline targets by id. A target is:

- **added** if it is only in the candidate,
- **removed** if it is only in the baseline,
- **changed** if any of `scientificName`, `scientificNameNormalized`, `commonName`, or `briefDescriptor` differ,
- **unchanged** otherwise.

Outputs:

- `data/candidate/diff-<v>.json`: the lists of ids.
- `data/candidate/report-<v>.md`: a human-readable summary with the baseline version, the counts, and the id lists.

This diff covers targets only. It does not compare tree structure or media.

### Step 13: Publish the approved dataset

This is the only step that changes what the web app serves.

1. `data/approved/dataset-<v>.json` is written, with manifest status `approved`.
2. `data/approved/latest.json` is written last, pointing to it.

Because the pointer is written last, a half-finished publish is never visible through `latest.json`.

### Step 14: Mirror to the web app

After the pipeline returns successfully, `scripts/data-refresh/src/index.ts` copies `latest.json` and the dataset file it names from `data/candidate/` to `apps/web/public/data/candidate/`, and the same for `data/approved/` to `apps/web/public/data/approved/`. This is a plain copy. Older files in the destination are never deleted. If `latest.json` is missing, nothing is copied.

Mirroring is skipped if any earlier step failed.

The web app loads the approved data at startup (`apps/web/src/data/runtimeDataset.ts`):

1. `GET /data/approved/latest.json`
2. `GET /data/approved/<fileName>`

If either request fails or the data is malformed, the app shows a warning and falls back to a built-in fixture tree.

## 5. Output files

All paths are relative to the repository root. All of `data/cache`, `data/candidate`, `data/approved`, and `apps/web/public/data/{candidate,approved}` are git-ignored, so these files are local artifacts and are not committed.

| Path | Written when | Contents |
|---|---|---|
| `data/cache/species-list-<ts>-<hash>.json` | Every run | Parsed targets and content hash |
| `data/cache/external-topology/<namespace>/<sha1>.json` | Each new OpenTree response | `{ cachedAt, value }` |
| `data/cache/external-media/<providerId>/<sha1>.json` | Each new provider response | `{ cachedAt, value }` |
| `data/candidate/topology-resolution-<v>.json` | Every run | Resolution summary and per-target status |
| `data/candidate/dataset-<v>.json` | Every run | Full candidate artifact |
| `data/candidate/latest.json` | Every run | Pointer to the latest candidate |
| `data/candidate/diff-<v>.json` | Every run | Target id differences |
| `data/candidate/report-<v>.md` | Every run | Human-readable diff report |
| `data/approved/dataset-<v>.json` | Only on success | Published artifact |
| `data/approved/latest.json` | Only on success | Pointer the web app reads |
| `apps/web/public/data/...` | Only on success | Copies of candidate and approved files |

Provider ids used as cache folder names: `gbif`, `open-tree`, `paleobiodb`, `inaturalist`, `phylopic`, `openverse`, `wikipedia-summary`, `wikipedia-links`.

Cache filenames are a SHA-1 hash of the request key. The Wikipedia cache keys include a version prefix (`v2:`), so changing that prefix forces a fresh fetch for all Wikipedia lookups.

## 6. Caching and retries

Caching applies to every external request:

- A successful response is cached, including a "no match" result (`null`). Future runs reuse it.
- A failed request (network error, timeout, or non-404 HTTP error) is not cached and is retried on the next run.
- A 404 from Wikipedia is treated as "no article" and cached as `null`.
- Requests that get HTTP 429 or 503 are retried with exponential backoff, or with the server's `Retry-After` value if given.
- Other failures are retried with backoff starting at about 240 ms (OpenTree) or 220 ms (media), doubled on each attempt.
- Each request has a timeout (default 9 seconds for OpenTree, `--media-timeout-ms` for media).

## 7. Success and failure

- The pipeline is sequential: any unrecoverable error stops the run.
- Steps 1 to 4 write into `data/cache/` (always) and `data/candidate/` (step 8 onward). A failed run therefore leaves partial candidate files, but the approved files are untouched.
- Approved files are written only in step 13, after everything else succeeded. A failed run never changes what the web app serves.
- The CLI prints a JSON summary on success and exits with code 1 on error.

## 8. Glossary

- **Target**: one of the species in `species-list.txt`. Targets are the species the game is built around.
- **Node**: any point in the tree, including leaves (species), internal branch points (clades), and the root (LUCA).
- **Clade**: a group of organisms that share a common ancestor, for example "Carnivora".
- **OTT id**: an OpenTree Taxonomy identifier. It is the stable key used to link a target to the OpenTree phylogeny.
- **TNRS**: Taxonomic Name Resolution Service. It maps a name to a known taxon.
- **Induced subtree**: the smallest tree that contains a given set of taxa.
- **Newick**: a text format for trees, used by OpenTree responses.
- **Unary node**: an internal node with exactly one child. These add no branching information and are sometimes pruned.
- **Navigation node**: an inserted intermediate node that keeps the tree navigable (no more than six children per node). It is not a real taxon.
- **Candidate**: a dataset produced by a run and not yet published. Compare it with approved.
- **Approved**: the published dataset the web app displays.
- **Baseline**: the approved dataset a new candidate is compared against.
- **Cache**: the on-disk store of raw external responses under `data/cache/`.

## 9. Known gaps and quirks

- `--media-online` in `scripts/data-refresh/package.json` is ignored. The CLI always runs online. Offline mode exists in the library code but cannot be reached from the command line.
- The web app loads only approved data. Candidate files are mirrored to `apps/web/public/data/candidate/` but are never loaded by the app.
- `buildCatalogScientificPhylogeny` (in `packages/scientific-data/src/compiler/buildCatalogScientificPhylogeny.ts`) and `buildFallbackCatalogTree` (in `buildOpenTreeScientificPhylogeny.ts`) are not called by the pipeline. They are dead code as of this writing.
- Mirroring never deletes old files in `apps/web/public/data/`.
- Caches have no expiry. Stale data stays until its cache file is deleted.
- The diff compares targets only, not tree structure or media.

