import { expect, test } from '@playwright/test';

const node = {
  id: 'mucor-mucedo',
  parentId: null,
  childIds: [],
  kind: 'named-taxon',
  displayName: 'Mucor mucedo',
  scientificName: 'Mucor mucedo',
  commonName: 'common pinmould',
  names: { singular: 'Common pinmould', plural: 'Common pinmould', clade: 'Common pinmould', provenance: 'seed' },
  description: 'A test taxon description.',
  descriptionSource: { articleTitle: 'Mucor mucedo', url: 'https://en.wikipedia.org/wiki/Mucor_mucedo' },
  isGameEndpoint: true,
  isTargetEligible: true,
  navigationOnly: false,
  extant: true,
  divergenceAgeMa: 0,
  traits: [],
  confidence: 'medium',
  provenance: []
};

for (const hasDescription of [true, false]) {
test(`decision lens keeps credits in information and shows target names (description available: ${hasDescription})`, async ({ page }) => {
  const imageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="green"/></svg>')}`;
  await page.route('**/data/approved/latest.json', (route) => route.fulfill({
    json: { datasetVersion: 'test', fileName: 'dataset-test.json', generatedAt: '2026-10-23T00:00:00Z' }
  }));
  await page.route('**/data/approved/dataset-test.json', (route) => route.fulfill({
    json: {
      manifest: { datasetVersion: 'test', generatedAt: '2026-10-23T00:00:00Z', speciesCount: 1, nodeCount: 1, validationStatus: 'approved' },
      scientificPhylogeny: { datasetVersion: 'test', rootId: node.id, nodesById: {
        [node.id]: hasDescription ? node : { ...node, description: undefined, descriptionSource: undefined }
      } },
      targets: [{ id: node.id, scientificName: node.scientificName, scientificNameNormalized: node.scientificName }],
      mediaEnrichment: {
        generatedAt: '2026-10-23T00:00:00Z',
        providerSnapshots: [],
        reconstructionQueue: [],
        targetDifficultyMetadata: [],
        nodeMediaByNodeId: { [node.id]: { nodeId: node.id, primaryAssetId: 'test-image', assetIds: ['test-image'] } },
        assetsById: {
          'test-image': {
            assetId: 'test-image', nodeId: node.id, kind: 'representative-image', url: imageUrl,
            title: 'Pinmould', confidence: 'medium', retrievedAt: '2026-10-23T00:00:00Z',
            attribution: {
              providerId: 'wikimedia-commons', attributionText: 'Test contributor', licenseCode: 'cc-by-sa',
              licenseName: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
              sourceUrl: 'https://commons.wikimedia.org/'
            }
          }
        }
      }
    }
  }));

  await page.goto('/');
  const lens = page.getByRole('region', { name: 'Decision lens preview' });
  await expect(lens.getByRole('heading', { name: 'Common pinmould', exact: true })).toBeVisible();
  await expect(lens.locator('.node-scientific-name i')).toHaveText('Mucor mucedo');
  const wikipedia = lens.getByRole('link', { name: 'Read about Common pinmould on Wikipedia' });
  await expect(wikipedia).toHaveAttribute('href', hasDescription
    ? 'https://en.wikipedia.org/wiki/Mucor_mucedo'
    : 'https://en.wikipedia.org/wiki/Mucor%20mucedo');
  await expect(wikipedia).toHaveAttribute('target', '_blank');
  await expect(lens.locator('.node-media img')).toBeVisible();
  if (hasDescription) {
    await expect(lens).toContainText('A test taxon description.');
    await expect(lens).not.toContainText('No encyclopedia description is available');
  } else {
    await expect(lens).toContainText('No encyclopedia description is available for this taxon.');
    await expect(lens).not.toContainText('Inferred endpoint hydration trait');
  }
  await expect(lens.locator('details')).toHaveCount(0);
  const positions = await lens.evaluate((element) => ({
    title: element.querySelector('h2')!.getBoundingClientRect().top,
    scientific: element.querySelector('.node-scientific-name')!.getBoundingClientRect().top,
    image: element.querySelector('img')!.getBoundingClientRect().top
  }));
  expect(positions.title).toBeLessThan(positions.scientific);
  expect(positions.scientific).toBeLessThan(positions.image);

  await page.getByRole('button', { name: 'Toggle information and credits' }).click();
  const information = page.getByRole('region', { name: 'Information and credits', exact: true });
  await expect(information.getByRole('region', { name: 'Selected node image credit', exact: true })).toContainText('Test contributor');
  await information.getByText('Tree image credits', { exact: true }).click();
  await expect(information.locator('.media-credits li')).toContainText('Test contributor');
  await expect(information.locator('.media-credits li a', { hasText: 'CC BY-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/');
  await page.getByRole('button', { name: 'Toggle information and credits' }).click();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await expect(page.getByLabel('Current target species')).toContainText('Common pinmould');
  await expect(lens.getByRole('heading', { name: 'Common pinmould', exact: true })).toBeVisible();
  await expect(lens.locator('.node-scientific-name i')).toHaveText('Mucor mucedo');
  await expect(lens.locator('.wikipedia-link')).toHaveCount(0);
});
}
