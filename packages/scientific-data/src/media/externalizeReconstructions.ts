import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MediaAssetRecord } from './types';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;utf8,';

// Moves inline SVG reconstruction payloads out of the artifact and into files, so the
// dataset JSON only carries a URL per asset.
export async function externalizeReconstructionAssets(
  assetsById: Record<string, MediaAssetRecord>,
  options: { outputDir: string; publicUrlPrefix: string }
): Promise<number> {
  let externalizedCount = 0;

  for (const asset of Object.values(assetsById)) {
    if (asset.kind !== 'reconstruction' || !asset.url.startsWith(SVG_DATA_URL_PREFIX)) {
      continue;
    }

    await mkdir(options.outputDir, { recursive: true });
    const fileName = `${asset.assetId.replace(/[^A-Za-z0-9._-]/g, '_')}.svg`;
    const svg = decodeURIComponent(asset.url.slice(SVG_DATA_URL_PREFIX.length));
    await writeFile(join(options.outputDir, fileName), svg, 'utf8');

    asset.url = `${options.publicUrlPrefix}/${fileName}`;
    externalizedCount += 1;
  }

  return externalizedCount;
}
