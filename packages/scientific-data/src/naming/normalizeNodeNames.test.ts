import { describe, expect, it } from 'vitest';

import type { PhyloNode, ScientificPhylogeny } from '@evo-tree/domain';

import type { TargetSpecies } from '../types';
import { deriveVernacularFromCladeName } from './morphology';
import { normalizeNodeNames } from './normalizeNodeNames';
import { pluralize } from './pluralize';

function node(partial: Partial<PhyloNode> & Pick<PhyloNode, 'id'>): PhyloNode {
  return {
    parentId: null,
    childIds: [],
    kind: 'unnamed-clade',
    displayName: partial.id,
    isGameEndpoint: false,
    isTargetEligible: false,
    navigationOnly: false,
    extant: true,
    traits: [],
    confidence: 'medium',
    provenance: [],
    ...partial
  } as PhyloNode;
}

describe('pluralize', () => {
  it.each([
    ['Mammal', 'Mammals'],
    ['Teleost', 'Teleosts'],
    ['Vertebrate', 'Vertebrates'],
    ['Fungus', 'Fungi'],
    ['Octopus', 'Octopuses'],
    ['Vascular plant', 'Vascular plants'],
    ['Clupeocephalan', 'Clupeocephalans']
  ])('pluralizes %s to %s', (singular, expected) => {
    expect(pluralize(singular)).toBe(expected);
  });
});

describe('deriveVernacularFromCladeName', () => {
  it.each([
    ['Clupeocephala', 'Clupeocephalan'],
    ['Craniata', 'Craniate'],
    ['Otophysi', 'Otophysan'],
    ['Cypriniphysae', 'Cypriniphysan'],
    ['Neocoleoidea', 'Neocoleoid'],
    ['Mucoromycetes', 'Mucoromycete'],
    ['Cypriniformes', 'Cypriniform'],
    ['Dipnotetrapodomorpha', 'Dipnotetrapodomorph'],
    ['Osteoglossocephalai', 'Osteoglossocephalan'],
    ['Bilateria', 'Bilaterian'],
    ['Cnidaria', 'Cnidarian'],
    ['Actinopterygii', 'Actinopterygian'],
    ['Sauropsida', 'Sauropsid'],
    ['Primatomorpha', 'Primatomorph'],
    ['Holozoa', 'Holozoan']
  ])('derives %s to %s', (clade, expected) => {
    expect(deriveVernacularFromCladeName(clade)).toBe(expected);
  });
});

describe('normalizeNodeNames', () => {
  const targets: TargetSpecies[] = [
    {
      id: 'homo-sapiens',
      scientificName: 'Homo sapiens',
      scientificNameNormalized: 'Homo sapiens',
      commonName: 'Human',
      briefDescriptor: 'Tool-using great ape'
    },
    {
      id: 'tyrannosaurus-rex',
      scientificName: 'Tyrannosaurus rex',
      scientificNameNormalized: 'Tyrannosaurus rex',
      commonName: 'Tyrannosaurus rex',
      briefDescriptor: 'Giant theropod'
    }
  ];

  function makeTree(): ScientificPhylogeny {
    return {
      datasetVersion: 'test',
      rootId: 'luca',
      nodesById: {
        luca: node({ id: 'luca', displayName: 'LUCA', childIds: ['mammalia', 'clupeocephala'] }),
        mammalia: node({
          id: 'mammalia',
          displayName: 'Mammalia',
          childIds: ['homo-sapiens'],
          descriptionSource: { articleTitle: 'Mammal', url: 'https://en.wikipedia.org/wiki/Mammal' }
        }),
        clupeocephala: node({
          id: 'clupeocephala',
          displayName: 'Clupeocephala',
          childIds: ['tyrannosaurus-rex']
        }),
        'homo-sapiens': node({
          id: 'homo-sapiens',
          displayName: 'Human',
          commonName: 'Human',
          scientificName: 'Homo sapiens',
          isGameEndpoint: true,
          isTargetEligible: true
        }),
        'tyrannosaurus-rex': node({
          id: 'tyrannosaurus-rex',
          displayName: 'Tyrannosaurus rex',
          commonName: 'Tyrannosaurus rex',
          scientificName: 'Tyrannosaurus rex',
          isGameEndpoint: true,
          isTargetEligible: true
        })
      }
    };
  }

  it('uses the validated Wikipedia vernacular for clades', () => {
    const { tree } = normalizeNodeNames(makeTree(), targets);
    const names = tree.nodesById['mammalia']?.names;

    expect(names).toEqual({
      singular: 'Mammal',
      plural: 'Mammals',
      clade: 'Mammalia',
      provenance: 'wikipedia-vernacular'
    });
  });

  it('derives a coined singular when no article exists', () => {
    const { tree } = normalizeNodeNames(makeTree(), targets);
    const names = tree.nodesById['clupeocephala']?.names;

    expect(names?.singular).toBe('Clupeocephalan');
    expect(names?.clade).toBe('Clupeocephala');
    expect(names?.provenance).toBe('morphological-rule');
  });

  it('keeps seed endpoints singular in every form', () => {
    const { tree } = normalizeNodeNames(makeTree(), targets);

    expect(tree.nodesById['homo-sapiens']?.names).toEqual({
      singular: 'Human',
      plural: 'Human',
      clade: 'Human',
      provenance: 'seed'
    });
    expect(tree.nodesById['tyrannosaurus-rex']?.names?.plural).toBe('Tyrannosaurus rex');
  });

  it('reverts to clade names when siblings would collide', () => {
    const tree = makeTree();
    const article = { articleTitle: 'Vertebrate', url: 'https://en.wikipedia.org/wiki/Vertebrate' };
    tree.nodesById['mammalia'] = node({
      id: 'mammalia',
      displayName: 'Vertebrata',
      childIds: [],
      descriptionSource: article
    });
    tree.nodesById['clupeocephala'] = node({
      id: 'clupeocephala',
      displayName: 'Craniata',
      childIds: [],
      descriptionSource: article
    });

    const result = normalizeNodeNames(tree, targets);

    expect(result.collisionFallbackCount).toBe(2);
    expect(result.tree.nodesById['mammalia']?.names?.singular).toBe('Vertebrata');
    expect(result.tree.nodesById['clupeocephala']?.names?.singular).toBe('Craniata');
    expect(result.warnings.some((warning) => warning.includes('Sibling name collision'))).toBe(true);
  });

  it('applies curated overrides ahead of every other source', () => {
    const { tree } = normalizeNodeNames(makeTree(), targets, {
      overrides: { mammalia: { singular: 'Beast' } }
    });

    expect(tree.nodesById['mammalia']?.names?.singular).toBe('Beast');
    expect(tree.nodesById['mammalia']?.names?.plural).toBe('Beasts');
    expect(tree.nodesById['luca']?.names?.singular).toBe('LUCA');
  });

  it('ignores a Latin article title and derives a vernacular instead', () => {
    const tree = makeTree();
    tree.nodesById['mammalia'] = node({
      id: 'mammalia',
      displayName: 'Bilateria',
      descriptionSource: {
        articleTitle: 'Bilateria',
        url: 'https://en.wikipedia.org/wiki/Bilateria'
      }
    });

    const { tree: named } = normalizeNodeNames(tree, targets);
    const names = named.nodesById['mammalia']?.names;

    expect(names?.singular).toBe('Bilaterian');
    expect(names?.plural).toBe('Bilaterians');
    expect(names?.clade).toBe('Bilateria');
    expect(names?.provenance).toBe('morphological-rule');
  });

  it('derives a vernacular when the article title is itself a Latin taxon name', () => {
    const tree = makeTree();
    tree.nodesById['mammalia'] = node({
      id: 'mammalia',
      displayName: 'Nucletmycea',
      descriptionSource: {
        articleTitle: 'Holomycota',
        url: 'https://en.wikipedia.org/wiki/Holomycota'
      }
    });

    const { tree: named } = normalizeNodeNames(tree, targets);
    const names = named.nodesById['mammalia']?.names;

    expect(names?.singular).toBe('Holomycote');
    expect(names?.plural).toBe('Holomycotes');
    expect(names?.clade).toBe('Nucletmycea');
  });

  it('leaves placeholder labels untouched instead of coining a vernacular', () => {
    const tree = makeTree();
    tree.nodesById['mrca-a'] = node({ id: 'mrca-a', displayName: 'mrca' });
    tree.nodesById['h12'] = node({ id: 'h12', displayName: 'h12' });
    tree.nodesById['luca'] = node({
      id: 'luca',
      displayName: 'LUCA',
      childIds: ['mrca-a', 'h12']
    });

    const { tree: named } = normalizeNodeNames(tree, targets);

    expect(named.nodesById['mrca-a']?.names?.singular).toBe('Mrca');
    expect(named.nodesById['mrca-a']?.names?.provenance).toBe('clade-fallback');
    expect(named.nodesById['h12']?.names?.singular).toBe('H12');
  });
});
