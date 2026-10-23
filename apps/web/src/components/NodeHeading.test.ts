import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PhyloNode } from '@evo-tree/domain';

import { NodeHeading } from './NodeHeading';

const node: PhyloNode = {
  id: 'mucor-mucedo',
  parentId: null,
  childIds: [],
  kind: 'named-taxon',
  displayName: 'Mucor mucedo',
  scientificName: 'Mucor mucedo',
  commonName: 'common pinmould',
  names: { singular: 'Common pinmould', plural: 'Common pinmould', clade: 'Common pinmould', provenance: 'seed' },
  descriptionSource: { articleTitle: 'Mucor mucedo', url: 'https://en.wikipedia.org/wiki/Mucor_mucedo' },
  isGameEndpoint: true,
  isTargetEligible: true,
  navigationOnly: false,
  extant: true,
  traits: [],
  confidence: 'medium',
  provenance: []
};

describe('NodeHeading', () => {
  it('shows the common title, italic scientific subtitle and resolved Wikipedia link in Explore', () => {
    const html = renderToStaticMarkup(createElement(NodeHeading, { node, showWikipediaLink: true }));
    expect(html).toContain('<h2>Common pinmould</h2>');
    expect(html).toContain('<i>Mucor mucedo</i>');
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Mucor_mucedo"');
    expect(html).toContain('aria-label="Read about Common pinmould on Wikipedia"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html.indexOf('<h2>')).toBeLessThan(html.indexOf('<i>'));
  });

  it('hides the Wikipedia icon outside Explore but keeps the target scientific subtitle', () => {
    const html = renderToStaticMarkup(createElement(NodeHeading, { node, showWikipediaLink: false }));
    expect(html).not.toContain('<a');
    expect(html).toContain('<i>Mucor mucedo</i>');
  });

  it('uses a scientific-name page link when no resolved article is available', () => {
    const withoutArticle = { ...node };
    delete withoutArticle.descriptionSource;
    const html = renderToStaticMarkup(createElement(NodeHeading, { node: withoutArticle, showWikipediaLink: true }));
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Mucor%20mucedo"');
  });

  it('does not add a target scientific subtitle to intermediary nodes', () => {
    const intermediary = { ...node, isGameEndpoint: false, isTargetEligible: false };
    const html = renderToStaticMarkup(createElement(NodeHeading, { node: intermediary, showWikipediaLink: true }));
    expect(html).not.toContain('node-scientific-name');
    expect(html).toContain('wikipedia-link');
  });
});
