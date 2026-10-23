import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MediaAssetRecord } from './types';
import { externalizeReconstructionAssets } from './externalizeReconstructions';

describe('externalizeReconstructionAssets', () => {
  it('writes inline reconstruction SVGs to files and rewrites asset URLs', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'evo-tree-media-'));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    const assetsById = {
      'reconstruction-luca': {
        assetId: 'reconstruction-luca',
        kind: 'reconstruction',
        url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
      },
      'inat-1': {
        assetId: 'inat-1',
        kind: 'photo',
        url: 'https://example.org/photo.jpg'
      }
    } as unknown as Record<string, MediaAssetRecord>;

    const count = await externalizeReconstructionAssets(assetsById, {
      outputDir,
      publicUrlPrefix: '/data/approved/media/test'
    });

    expect(count).toBe(1);
    expect(assetsById['reconstruction-luca']?.url).toBe('/data/approved/media/test/reconstruction-luca.svg');
    expect(assetsById['inat-1']?.url).toBe('https://example.org/photo.jpg');
    expect(await readFile(join(outputDir, 'reconstruction-luca.svg'), 'utf8')).toBe(svg);
  });
});
