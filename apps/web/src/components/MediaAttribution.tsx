import { useState } from 'react';
import type { PhyloNode } from '@evo-tree/domain';

import type { RuntimeMediaAssetRecord } from '../data/runtimeDataset';

export function MediaAttribution({ asset }: { asset: RuntimeMediaAssetRecord }) {
  const { attribution } = asset;
  return (
    <span className="media-attribution">
      {asset.kind === 'representative-image' ? 'Representative image. ' : ''}
      {attribution.attributionText}{' '}
      {attribution.sourceUrl ? (
        <a href={attribution.sourceUrl} target="_blank" rel="noopener noreferrer">Source</a>
      ) : null}
      {' | '}
      {attribution.licenseUrl ? (
        <a href={attribution.licenseUrl} target="_blank" rel="noopener noreferrer">{attribution.licenseName}</a>
      ) : attribution.licenseName}
      {' | Display may be resized or cropped.'}
    </span>
  );
}

export function TreeMediaCredits({ assets, nodes }: {
  assets: Record<string, RuntimeMediaAssetRecord>;
  nodes: Record<string, PhyloNode>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="media-credits" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Tree image credits</summary>
      {open ? (
        <>
          <p>Article lead images represent taxa; they are not necessarily photographs of an exact species or its ancestor.</p>
          <ul>
            {Object.values(assets).filter((asset) => asset.kind !== 'reconstruction').map((asset) => (
              <li key={asset.assetId}>
                {asset.title ?? nodes[asset.nodeId]?.displayName ?? asset.nodeId}: <MediaAttribution asset={asset} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}
