import type { PhyloNode, ScientificPhylogeny } from './types';

function node(partial: Omit<PhyloNode, 'traits' | 'provenance' | 'confidence'>): PhyloNode {
  return {
    ...partial,
    traits: [],
    confidence: 'medium',
    provenance: [
      {
        sourceId: 'fixture-reference',
        sourceType: 'curated',
        note: 'Milestone 1 scientific fixture for algorithm tests.'
      }
    ]
  };
}

export const fixtureScientificPhylogeny: ScientificPhylogeny = {
  datasetVersion: 'fixture-0.1.0',
  rootId: 'luca',
  nodesById: {
    luca: node({
      id: 'luca',
      parentId: null,
      childIds: ['bacteria', 'eukaryota'],
      kind: 'ancestral',
      displayName: 'LUCA',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: false,
      divergenceAgeMa: 3900
    }),
    bacteria: node({
      id: 'bacteria',
      parentId: 'luca',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Bacteria',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 3500
    }),
    eukaryota: node({
      id: 'eukaryota',
      parentId: 'luca',
      childIds: ['opisthokonta', 'archaeplastida'],
      kind: 'named-taxon',
      displayName: 'Eukaryota',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 1800
    }),
    archaeplastida: node({
      id: 'archaeplastida',
      parentId: 'eukaryota',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Archaeplastida',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 1500
    }),
    opisthokonta: node({
      id: 'opisthokonta',
      parentId: 'eukaryota',
      childIds: ['fungi', 'metazoa'],
      kind: 'named-taxon',
      displayName: 'Opisthokonta',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 1200
    }),
    fungi: node({
      id: 'fungi',
      parentId: 'opisthokonta',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Fungi',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 1000
    }),
    metazoa: node({
      id: 'metazoa',
      parentId: 'opisthokonta',
      childIds: ['bilateria', 'cnidaria'],
      kind: 'named-taxon',
      displayName: 'Metazoa',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 800
    }),
    cnidaria: node({
      id: 'cnidaria',
      parentId: 'metazoa',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Cnidaria',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 700
    }),
    bilateria: node({
      id: 'bilateria',
      parentId: 'metazoa',
      childIds: ['deuterostomia', 'protostomia'],
      kind: 'named-taxon',
      displayName: 'Bilateria',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 650
    }),
    protostomia: node({
      id: 'protostomia',
      parentId: 'bilateria',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Protostomia',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 620
    }),
    deuterostomia: node({
      id: 'deuterostomia',
      parentId: 'bilateria',
      childIds: ['chordata'],
      kind: 'named-taxon',
      displayName: 'Deuterostomia',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 610
    }),
    chordata: node({
      id: 'chordata',
      parentId: 'deuterostomia',
      childIds: ['mammalia'],
      kind: 'named-taxon',
      displayName: 'Chordata',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 560
    }),
    mammalia: node({
      id: 'mammalia',
      parentId: 'chordata',
      childIds: ['primates', 'panthera'],
      kind: 'named-taxon',
      displayName: 'Mammalia',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 220
    }),
    primates: node({
      id: 'primates',
      parentId: 'mammalia',
      childIds: ['homo-sapiens'],
      kind: 'named-taxon',
      displayName: 'Primates',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 55
    }),
    'homo-sapiens': node({
      id: 'homo-sapiens',
      parentId: 'primates',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Human',
      scientificName: 'Homo sapiens',
      commonName: 'Human',
      isGameEndpoint: true,
      isTargetEligible: true,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 0
    }),
    panthera: node({
      id: 'panthera',
      parentId: 'mammalia',
      childIds: ['panthera-leo', 'panthera-tigris'],
      kind: 'unnamed-clade',
      displayName: 'Panthera clade',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 6
    }),
    'panthera-leo': node({
      id: 'panthera-leo',
      parentId: 'panthera',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Lion',
      scientificName: 'Panthera leo',
      commonName: 'Lion',
      isGameEndpoint: true,
      isTargetEligible: true,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 0
    }),
    'panthera-tigris': node({
      id: 'panthera-tigris',
      parentId: 'panthera',
      childIds: [],
      kind: 'named-taxon',
      displayName: 'Tiger',
      scientificName: 'Panthera tigris',
      commonName: 'Tiger',
      isGameEndpoint: true,
      isTargetEligible: true,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 0
    })
  }
};
