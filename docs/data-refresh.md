# Data Refresh (`npm run data`)

This document describes everything that happens when you run `npm run data` from the repository root. It is written for new developers and for AI models that need a reference for how the scientific dataset is produced.

## 1. Purpose

Evolution Explorer is a web app that lets people explore the evolutionary history of life as a navigable tree. The tree starts at the Last Universal Common Ancestor (LUCA) and branches out to a curated list of target species (for example, humans, zebrafish, and a bacterium). Each node in the tree needs a name, a description, sometimes a picture, and a position in a real phylogeny.

The web app does not build that data itself. It reads pre-built JSON files from `apps/web/public/data/approved/`. `npm run data` is the job that builds those files. It:

1. Reads the target species list.
2. Looks up each species in public scientific databases (OpenTree, GBIF, Paleobiology Database, iNaturalist, Wikipedia, PhyloPic, and Openverse).
3. Assembles a single phylogenetic tree from the results.
4. Hydrates every named, non-navigation node through the same Wikipedia-first description and image workflow, whether it is a target or an intermediary clade.
5. Writes a candidate dataset, compares it with the last approved dataset, and, only if everything succeeds, publishes it as the new approved dataset.

The result is a versioned, self-describing JSON artifact that the web app loads at startup and renders graphically.

## 2. How to run it

| Command | What it does |
|---|---|
| `npm run data` | Full refresh. Calls external APIs for any lookup that is not already cached on disk, then builds, diffs, and publishes. This is the only supported entry point. |
| `npm run data -- --media-target-limit=20` | Limits supplementary target taxonomy lookups to the first 20 targets. Descriptions and images still hydrate every named node; this is not a whole-run or node-hydration limit. |
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
| 0.1 | Prepare directories | None | Creates `data/cache`, `data/candidate`, `data/approved` |
| 0.2 | Parse species list | None | In memory |
| 0.3 | Assign dataset version | None | In memory |
| 0.4 | Save source snapshot | None | `data/cache/species-list-<timestamp>-<hash>.json` |
| 0.5 | Load baseline | None | In memory (read from `data/approved/`) |
| 1 | Build topology (OpenTree) | TNRS, induced subtree | In memory; lookups cached |
| 1.5 | Write topology report | None | `data/candidate/topology-resolution-<v>.json` |
| 2 | Enrich media and taxonomy | GBIF, OpenTree, PBDB, iNaturalist, PhyloPic, Openverse, Wikipedia | In memory; lookups cached |
| 3 | Finalize | None | Copies to `apps/web/public/data/` |

### Step 0.1: Prepare directories

The run creates `data/cache/`, `data/candidate/`, and `data/approved/` if they do not exist.

### Step 0.2: Parse the species list

Input: `data/source/species-list.txt`.

- The first non-empty line must match the header exactly: `Scientific name`.
- Each following non-empty line contains only a scientific name, for example `Homo sapiens`. Pipe-separated common names or descriptors are rejected. All three checked-in species lists use this format.
- The list specifies which taxa the game targets. It is not a source of descriptions or common names; those are supplied by API hydration. Taxa above species rank can also be targets.
- A stable `id` is derived from the scientific name. It is lowercased, and runs of non-alphanumeric characters become `-`. For example, `Homo sapiens` becomes `homo-sapiens`.
- Duplicate ids are rejected.
- Bad rows do not stop the run. They are recorded as "row issues" and written to the topology report in step 8. If no valid rows remain, the run fails.

The result is an in-memory list of targets. The current list has 11 targets, including Homo sapiens, Pan troglodytes, Tyrannosaurus rex, Danio rerio, and Bdellovibrio bacteriovorus.

### Step 0.3: Assign a dataset version

Versions look like `YYYY.MM.DD.N`, using the current UTC date. `N` is one more than the highest sequence already present for that date in `data/candidate/` and `data/approved/`. The version is kept in memory and used in every output filename below.

### Step 0.4: Save a source snapshot

The full parsed species list, along with a content hash, is written to:

`data/cache/species-list-<ISO timestamp with ':' and '.' replaced by '-'>-<first 12 chars of SHA-256>.json`

Example: `data/cache/species-list-2026-10-22T00-57-11-300Z-ead904351e4c.json`

This records exactly which input produced the dataset. The hash is the same across runs when the list has not changed.

### Step 0.5: Load the baseline

The pipeline reads `data/approved/latest.json` and then the dataset file it points to. This is the previously published dataset. It is used only for the diff in step 12. If no pointer exists, the pipeline uses the last `dataset-*.json` in `data/approved/` by name.

### Step 1: Build the topology (OpenTree)

This step builds the tree structure. It uses the **Open Tree of Life** (OpenTree), which provides a synthesized phylogeny with stable taxon identifiers called OTT ids.

**1.1. Name resolution (TNRS).** For each target, the pipeline sends one request:

- `POST https://api.opentreeoflife.org/v3/tnrs/match_names`
- Body: `{ names: [<scientific name>], include_suppressed: false, do_approximate_matching: true }`
- Requests are sent one at a time.
- Each target ends with one status: `matched` (has an OTT id), `unmatched` (no match), `lookup-failed` (the request failed), or `skipped-offline`.
- Results are cached under `data/cache/external-topology/open-tree-tnrs/`.
- The run needs at least two resolved targets, or it fails.

**1.2. Induced subtree.** The pipeline asks OpenTree for the minimal tree that connects all matched OTT ids:

- `POST https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree`
- Body: `{ ott_ids: [<sorted unique OTT ids>] }`
- Result is cached under `data/cache/external-topology/open-tree-induced-subtree/`.
- If the single request fails, the pipeline splits the ids in half and retries each half, recursively. Chunks of four or fewer ids are abandoned. Relationships between abandoned chunks are lost, and a warning is recorded. The report field `usedAdaptiveChunking` shows whether this happened.
- The response is a Newick string (a text format for trees). It is parsed in memory.

**1.3. Build in-memory tree.** The pipeline turns the Newick tree into nodes:

- The root node has id `luca`, is labeled LUCA, and is assigned an age of 3,900 million years. Its confidence is `medium`.
- Ages for internal nodes are estimated from their depth in the tree. These are approximations, not measured dates.
- Targets that OpenTree could not place are attached under a separate branch with id `target-catalog-root`.
- Large internal groups are split into navigation sub-nodes so that no navigation node has more than six children. These are marked `navigationOnly`.

Output: an in-memory tree. Nothing is written to disk in this step except the cached HTTP responses.

**Step 1.4: Prune unary nodes**

A unary node is an internal node with exactly one child. The pruner removes unary internal nodes whose confidence is `navigationOnly`, `low`, or `unresolved`. It never removes a target or a game endpoint. Output is in memory.

**Step 1.5: Write the topology report**

`data/candidate/topology-resolution-<v>.json` records:

- Endpoint names used for the start and end of the game path (`nameResolution`, `inducedSubtree`).
- Summary counts: `totalTargets`, `matched`, `unmatched`, `lookupFailed`, `skippedOffline`, `placedInTopology`, `inducedSubtreeChunkCount`, `usedAdaptiveChunking`.
- Per-target resolution status.
- Source row issues from step 2.

A recent run recorded: 11 targets, 11 matched, 11 placed, 1 induced-subtree chunk, no adaptive chunking.

### Step 2: Enrich media, taxonomy, and descriptions

This is the largest step. The phases are target taxonomy (`target-media`, a historical progress-event name), shared article/description hydration (`node-descriptions`), and shared image hydration (`node-media`). Descriptions and images use the same process for target endpoints and intermediary named taxa. There is no default 180-target image cap.

OpenTree still defines the scientific topology. GBIF and PBDB still supplement target taxonomy and extinction metadata. Wikipedia is the primary presentation-content source, not a replacement for those scientific providers.

**Taxonomy and common names (per target, four lookups in parallel):**

| Provider | Request | Result |
|---|---|---|
| GBIF | `GET https://api.gbif.org/v1/species/match?name=<name>` | GBIF key, becomes `taxonId` `gbif:<key>` |
| OpenTree | Same TNRS endpoint as step 6a | Becomes `taxonId` `ott:<id>` when GBIF has no key |
| Paleobiology Database | `GET https://paleobiodb.org/data1.2/taxa/list.json?name=<name>&show=attr` | If the taxon looks extinct, sets `extant=false` and `extinctionAgeMa` |
| iNaturalist | `GET https://api.inaturalist.org/v1/taxa?q=<name>&per_page=10&is_active=true&locale=en` | An exact scientific-name match supplies `preferred_common_name` for the primary target label. This metadata is independent of whether its photo is licensed for use. |

The iNaturalist exact-match taxon records and provenance are cached on disk under the `inat-taxa-v1:` key. The photo fallback reads the same cached records; it does not repeat the network request. Common names are normalized for capitalization during name finalization and used consistently in map labels, the target bar, and decision-lens headings. If iNaturalist has no common name, a differing Wikipedia article title remains a fallback; otherwise the scientific name is retained rather than inventing a common name.

**Resolve an article and description (every named, non-navigation node):**

- Wikipedia summary: `GET https://en.wikipedia.org/api/rest_v1/page/summary/<title>`. The pipeline tries several title variants (plain name, raw name, `(genus)`, `(biology)`). Disambiguation pages are rejected.
- Lead links: `GET https://en.wikipedia.org/w/api.php?action=parse&prop=text&section=0&redirects=1&format=json&formatversion=2&page=<title>`. The HTML of the lead section is scanned for links to other articles. These links become inline `descriptionSegments` so the web app can link words inside a description.
- Descriptions are trimmed to whole sentences within `--description-max-chars` (default 500).
- The cached article record contains the extract, resolved title, article URL, original-image URL, thumbnail URL, and provenance. That same record feeds image selection: the image does not trigger a separate summary lookup.
- Existing descriptions are replaced by the API result, including on targets. On an unresolved lookup they are cleared rather than silently retaining source-file or stale authored text.
- If multiple nodes resolve to the same article, the closest name match retains it. Other nodes also retain the shared article and image when their full taxon name is explicitly mentioned as a whole phrase in the complete API summary, or their name matches the article title. This supports legitimate species-to-genus redirects such as `Tyrannosaurus rex` → `Tyrannosaurus` and `Fungia fungites` → `Fungia`, while still rejecting unsupported broad-article assignments. This check uses the original summary before display-length truncation. Rejected nodes can still use independent image-provider fallbacks.
- When no structured common name was found, a differing resolved article title supplies a display-name candidate (for example `Homo sapiens` redirects to `Human`); it does not overwrite an existing hydrated common name. The scientific name and stable node id are preserved. An article title is not a guaranteed taxonomic common-name authority.
- Endpoints without a usable description display an explicit unavailable-description notice, not generated endpoint-trait text masquerading as a taxon description. Intermediary nodes may still use generated lineage text at display time.

Article resolution and image hydration each run in batches of at most six nodes concurrently. Unnamed MRCA/OpenTree placeholders and navigation-only groupings are not queried as if they were named taxa.

**Image selection (same policy for targets and intermediaries):**

The first usable provider wins; later providers are not queried once an image is found.

1. **Wikipedia article lead image, verified on Commons.** Use the resolved article's `originalimage.source`, or `thumbnail.source` if no original exists. Only images hosted on `upload.wikimedia.org` or `thumb.wikimedia.org`, under `/wikipedia/commons/` over HTTPS, are eligible. The file name is extracted from the URL and queried using `GET https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata&iiextmetadatafilter=LicenseShortName|LicenseUrl|Artist|Credit|Attribution&format=json&formatversion=2&titles=File:<name>`. The pipeline retains the creator/credit text, file-page URL, exact license name and license URL. Only recognized public-domain/CC0/CC BY/CC BY-SA metadata is accepted; attribution-required files without usable creator/attribution metadata are rejected. Wikipedia-local non-free images are not used. Provider id: `wikimedia-commons`; asset kind: `representative-image`.
2. **iNaturalist**, for extant nodes or clades with children. `GET https://api.inaturalist.org/v1/taxa?q=<name>&per_page=10&is_active=true&locale=en`. Results must match the requested scientific name after whitespace/case normalization. Relatives are skipped. A `default_photo` must have a commercial-compatible license; NC, ND, null, and unknown codes are rejected.
3. **PhyloPic.** Read the build number once per enrichment run from `GET https://api.phylopic.org/`, then query `GET https://api.phylopic.org/nodes?build=<build>&page=0&filter_name=<name>&embed_items=true&embed_primaryImage=true` with the v2 Accept header. Names are lowercased, with whitespace normalized and URL-encoded (for example `homo%20sapiens`, not `homo-sapiens`). Use the first embedded primary image with a recognized commercial-compatible Creative Commons license URL. Preserve its license URL and attribution. Unknown or NC/ND licenses are not accepted.
4. **Openverse**, for extinct endpoints. `GET https://api.openverse.engineering/v1/images/?q=<name> paleoart silhouette&license_type=commercial&extension=jpg&page_size=5`. The first result with an image URL and an independently allowed license code is used. The API's commercial filter alone is not trusted; unknown licenses are rejected. License-version metadata is retained in the license URL when available.

Each asset gets an id of the form `<kind>-<nodeId>-<12-char hash>`. The selected primary asset and node mapping are accumulated in memory, then serialized into the dataset. A representative article image may depict a related taxon, a fossil, or an illustration. It must not be interpreted as a photograph or reconstruction of the common ancestor.

**Structural placeholders:** Generated title-card SVGs are retained only for unnamed or navigation-only internal structures. Named nodes no longer receive these as substitute images. If every image provider misses, the named node is recorded as missing an image rather than masquerading as a reconstruction.

**Licensing and display:** Wikipedia text attribution is stored in `descriptionSource` (article URL/title, Wikipedia contributors, CC BY-SA 4.0 license URL, and whether the excerpt was shortened). The web app displays article attribution and a license link even when the article title matches the node label. Image attribution and license links are in the top-bar information (`i`) panel, including the selected node, the active target when different, and expandable tree image credits. Image credits are not displayed in the decision lens. In Explore mode the decision-lens heading has a Wikipedia link; target headings use the common name, with the scientific name in a smaller italic subtitle above the image. Cropping/resizing is disclosed. ShareAlike and any other applicable per-file requirements still apply; allowing commercial reuse does not eliminate these obligations. Previously accepted iNaturalist NC assets are not reused by the new cache keys.

**Difficulty metadata:** Each target gets a familiarity score from a keyword heuristic using its scientific name and hydrated common name, not an authored descriptor. Values are 0.92, 0.55, 0.3, or 0.25. No extra API call is made.

**Coverage and provider statistics:** `mediaEnrichment.coverage` in both dataset artifacts, and `summary.media.coverage` in the CLI result, report targets and intermediaries separately. Each group records `total`, `withDescription`, `withImage`, `missingDescriptionNodeIds`, and `missingImageNodeIds`. Percent coverage can be computed from these counts; missing images are not counted as successes. Provider requests, cache hits, successes, failures, and notes are stored in `mediaEnrichment.providerSnapshots`. Provider success means the lookup completed, not necessarily that it found an asset.

**Limits:** `--media-target-limit=N` now restricts supplementary target taxonomy only; it does not restrict named-node descriptions or images. Warnings make that distinction explicit. Use the small species list to test a smaller complete tree.

Output: taxonomy, article records, media metadata, and descriptions are assembled in memory and written into the candidate and approved datasets during finalization. Provider lookup results are persisted under `data/cache/external-media/<providerId>/<sha1>.json`; they are not memory-only. The cache contains parsed lookup results, not downloaded image binaries. Selected external images remain remote URLs; the browser loads thumbnails as needed. Structural SVGs are built in memory, then externalized to `data/approved/media/<datasetVersion>/<assetId>.svg` and referenced by `/data/approved/media/<datasetVersion>/<assetId>.svg`. The CLI mirrors that directory to `apps/web/public/data/approved/media/<datasetVersion>/`.

### Step 3: Finalize

**Normalize names**
This step is offline. It produces three name forms for each node: singular, plural, and clade.

- Seed targets use their API-hydrated common name in all forms (for example, "Zebrafish"), falling back to the scientific name if none is available.
- Three fixed overrides apply: LUCA, Bacteria (singular "Bacterium"), and Archaea (singular "Archaeon").
- Otherwise, the name comes from the Wikipedia article's vernacular title when it is English. If the title is a Latin taxon name, a morphology rule derives an English form (for example, "Carnivora" becomes "carnivoran"). Plurals use simple English pluralization rules.
- Placeholder labels such as `MRCA ...`, `H123`, and `OpenTree clade ...` do not get their own names. They are left for runtime compaction.
- If two siblings end up with the same singular name, both revert to clade names and a warning is recorded.

Output: in memory.

**Write the candidate dataset**

- `data/candidate/dataset-<v>.json`: the full artifact. It has a manifest with status `candidate`, the targets, the tree, the topology metadata, the media enrichment data, and the provider statistics. The tree's version is suffixed with `+media`.
- `data/candidate/latest.json`: a small pointer (`datasetVersion`, `fileName`, `generatedAt`).

**Diff against the baseline**

The pipeline compares the candidate targets with the baseline targets by id. A target is:

- **added** if it is only in the candidate,
- **removed** if it is only in the baseline,
- **changed** if `scientificName` or `scientificNameNormalized` differs (hydrated descriptions and common names are not source-list fields and are not part of this target-list diff),
- **unchanged** otherwise.

Outputs:

- `data/candidate/diff-<v>.json`: the lists of ids.
- `data/candidate/report-<v>.md`: a human-readable summary with the baseline version, the counts, and the id lists.

This diff covers targets only. It does not compare tree structure or media.

**Publish the approved dataset**

This is the only step that changes what the web app serves.

1. `data/approved/dataset-<v>.json` is written, with manifest status `approved`.
2. `data/approved/latest.json` is written last, pointing to it.

Because the pointer is written last, a half-finished publish is never visible through `latest.json`.

**Mirror to the web app**

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

Provider ids used as cache folder names: `gbif`, `open-tree`, `paleobiodb`, `inaturalist`, `phylopic`, `openverse`, `wikipedia-summary`, `wikipedia-links`, `wikimedia-commons`.

Cache key versions: `inat-taxa-v1:` (iNaturalist exact-match common names and photo metadata), `v3:` (shared Wikipedia article record), `file-license-commercial-v2:` (Commons license), `phylopic-commercial-v3:` (PhyloPic), and `commercial-v2:` (Openverse). Wikipedia lead links retain their existing version. The older `lead-photo-v1:` records are unused. Changing a version prefix forces a fresh lookup under the new policy; no manual cache deletion is necessary for this migration.

Cache filenames are a SHA-1 hash of the request key. Cache records live on disk indefinitely; only the small metadata records needed for the current tree are assembled in memory.

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
- **Cache**: the on-disk store of parsed provider lookup results under `data/cache/`, including no-match results. It does not contain downloaded external image binaries.

## 9. Known gaps and quirks

- `--media-online` in `scripts/data-refresh/package.json` is ignored. The CLI always runs online. Offline mode exists in the library code but cannot be reached from the command line.
- The web app loads only approved data. Candidate files are mirrored to `apps/web/public/data/candidate/` but are never loaded by the app.
- `buildCatalogScientificPhylogeny` (in `packages/scientific-data/src/compiler/buildCatalogScientificPhylogeny.ts`) and `buildFallbackCatalogTree` (in `buildOpenTreeScientificPhylogeny.ts`) are not called by the pipeline. They are dead code as of this writing.
- Mirroring never deletes old files in `apps/web/public/data/`.
- Caches have no expiry. Stale data stays until its cache file is deleted.
- The diff compares targets only, not tree structure or media.
