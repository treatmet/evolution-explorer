const IRREGULAR_PLURALS: Record<string, string> = {
  fungus: 'fungi',
  octopus: 'octopuses',
  bacterium: 'bacteria',
  alga: 'algae',
  larva: 'larvae',
  genus: 'genera',
  mouse: 'mice',
  louse: 'lice',
  man: 'men',
  woman: 'women',
  child: 'children',
  tooth: 'teeth',
  foot: 'feet'
};

const NO_CHANGE_PLURALS = new Set(['fish', 'sheep', 'deer', 'species', 'series']);

/** Pluralizes only the final word so phrases such as "Vascular plant" stay readable. */
export function pluralize(singular: string): string {
  const trimmed = singular.trim();
  if (!trimmed) {
    return trimmed;
  }

  const parts = trimmed.split(' ');
  const last = parts[parts.length - 1] ?? '';
  const pluralLast = pluralizeWord(last);

  parts[parts.length - 1] = matchCasing(last, pluralLast);
  return parts.join(' ');
}

function pluralizeWord(word: string): string {
  const lower = word.toLowerCase();

  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular) {
    return irregular;
  }

  if (NO_CHANGE_PLURALS.has(lower)) {
    return lower;
  }

  if (/(s|x|z|ch|sh)$/.test(lower)) {
    return `${lower}es`;
  }

  if (/[^aeiou]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }

  return `${lower}s`;
}

function matchCasing(source: string, value: string): string {
  if (!source || !value) {
    return value;
  }

  const startsUpper = source[0] === source[0]?.toUpperCase();
  return startsUpper ? capitalize(value) : value;
}

export function capitalize(value: string): string {
  if (!value) {
    return value;
  }

  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}
