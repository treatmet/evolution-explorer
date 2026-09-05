import { capitalize } from './pluralize';

/** Standard vernacular derivations from zoological/botanical clade endings, longest suffix first. */
const SUFFIX_RULES: ReadonlyArray<{ suffix: string; replacement: string }> = [
  { suffix: 'morpha', replacement: 'morph' },
  { suffix: 'formes', replacement: 'form' },
  { suffix: 'oidea', replacement: 'oid' },
  { suffix: 'aceae', replacement: 'acean' },
  { suffix: 'ophyta', replacement: 'ophyte' },
  { suffix: 'phyta', replacement: 'phyte' },
  { suffix: 'idae', replacement: 'id' },
  { suffix: 'ineae', replacement: 'ine' },
  { suffix: 'inae', replacement: 'ine' },
  { suffix: 'etes', replacement: 'ete' },
  { suffix: 'ida', replacement: 'id' },
  { suffix: 'ata', replacement: 'ate' },
  { suffix: 'ota', replacement: 'ote' },
  { suffix: 'zoa', replacement: 'zoan' },
  { suffix: 'yes', replacement: 'yan' },
  { suffix: 'ae', replacement: 'an' },
  { suffix: 'ai', replacement: 'an' },
  { suffix: 'ia', replacement: 'ian' },
  { suffix: 'a', replacement: 'an' },
  { suffix: 'i', replacement: 'an' }
];

/** Endings that mark a word as a Latin taxon name rather than an English vernacular. */
const LATIN_TAXON_ENDING =
  /(?:ota|ata|ida|idae|inae|aceae|oidea|morpha|formes|phyta|zoa|ae|ii|yes)$/i;

export function looksLikeLatinTaxonName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes(' ') && LATIN_TAXON_ENDING.test(trimmed);
}

export function deriveVernacularFromCladeName(cladeName: string): string | undefined {
  const trimmed = cladeName.trim();
  if (!trimmed || trimmed.includes(' ')) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();

  for (const rule of SUFFIX_RULES) {
    if (!lower.endsWith(rule.suffix) || lower.length <= rule.suffix.length) {
      continue;
    }

    const stem = lower.slice(0, lower.length - rule.suffix.length);
    return capitalize(`${stem}${rule.replacement}`);
  }

  return undefined;
}
