import { resolveNodeLabel, type PhyloNode } from '@evo-tree/domain';

import { DEFAULT_NAME_FORM } from '../config/naming';

export function NodeHeading({ node, showWikipediaLink }: {
  node: PhyloNode;
  showWikipediaLink: boolean;
}) {
  const label = resolveNodeLabel(node, DEFAULT_NAME_FORM);
  const articleUrl = node.descriptionSource?.url ||
    `https://en.wikipedia.org/wiki/${encodeURIComponent(node.scientificName ?? node.displayName)}`;

  return (
    <>
      <div className="decision-title-row">
        <h2>{label}</h2>
        {showWikipediaLink ? (
          <a
            className="wikipedia-link"
            href={articleUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Read about ${label} on Wikipedia`}
            title="Read on Wikipedia"
          >
            <span aria-hidden="true">W</span>
          </a>
        ) : null}
      </div>
      {(node.isGameEndpoint || node.isTargetEligible) && node.scientificName ? (
        <p className="node-scientific-name"><i>{node.scientificName}</i></p>
      ) : null}
    </>
  );
}
