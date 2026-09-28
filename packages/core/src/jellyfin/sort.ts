import type { MetaPreview } from '../db/schemas.js';
import { sortNameFor } from './dto.js';
import {
  imdbRatingOf,
  parseRuntimeMs,
  parseYear,
  readEnrichment,
  toIso,
  type Enrichment,
} from './enrichment.js';

/** The Jellyfin `SortBy` keys a catalog entry can answer on its own. */
export const LIBRARY_SORT_KEYS = [
  'sortname',
  'premieredate',
  'datecreated',
  'productionyear',
  'communityrating',
  'criticrating',
  'runtime',
] as const;

export type LibrarySortKey = (typeof LIBRARY_SORT_KEYS)[number];

export interface LibrarySortTerm {
  key: LibrarySortKey;
  descending: boolean;
}

const ALIASES: Record<string, LibrarySortKey> = { name: 'sortname' };

function keyFor(value: string): LibrarySortKey | undefined {
  const lower = value.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  return (LIBRARY_SORT_KEYS as readonly string[]).includes(lower)
    ? (lower as LibrarySortKey)
    : undefined;
}

/**
 * The order a request asks a library for, or null when catalog order stands:
 * nothing asked, `Random` or `Default` first, or no key a catalog entry can
 * answer. As Jellyfin pairs them, `SortOrder[i]` goes with `SortBy[i]` and keys
 * past the last order take the first one given, else ascending. Keys an entry
 * cannot answer (play state, folders, studios) are passed over; `Default`
 * ends the list, since catalog order already breaks every tie.
 */
export function parseLibrarySort(
  sortBy: string[],
  sortOrder: string[]
): LibrarySortTerm[] | null {
  const first = sortBy[0]?.toLowerCase();
  if (!first || first === 'random' || first === 'default') return null;
  const orders = sortOrder.map((o) => o.toLowerCase().startsWith('desc'));
  const fallback = orders[0] ?? false;
  const terms: LibrarySortTerm[] = [];
  const used = new Set<LibrarySortKey>();
  for (const [i, value] of sortBy.entries()) {
    if (value.toLowerCase() === 'default') break;
    const key = keyFor(value);
    if (!key || used.has(key)) continue;
    used.add(key);
    terms.push({ key, descending: orders[i] ?? fallback });
  }
  return terms.length ? terms : null;
}

type SortValue = string | number | undefined;

/**
 * An entry's value for one key, read the way `buildContentItem` fills the
 * matching item field, so the list is in the order its items display.
 */
function valueOf(
  key: LibrarySortKey,
  entry: MetaPreview,
  enrichment: () => Enrichment
): SortValue {
  const meta = entry as MetaPreview & Record<string, unknown>;
  switch (key) {
    case 'sortname':
      return sortNameFor((meta.name as string | undefined) ?? meta.id);
    case 'premieredate':
    case 'datecreated': {
      // An item without a premiere shows a placeholder DateCreated; that is
      // not a date, so it sorts as missing.
      const iso = enrichment().premiere ?? toIso(meta.released);
      return iso ? Date.parse(iso) : undefined;
    }
    case 'productionyear':
      return enrichment().year ?? parseYear(meta.releaseInfo);
    case 'communityrating':
      return imdbRatingOf(entry);
    case 'criticrating':
      return enrichment().criticRating;
    case 'runtime':
      return enrichment().runtimeMs ?? parseRuntimeMs(meta.runtime);
  }
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Sorts catalog entries by `terms`. An entry missing a value goes after every
 * entry that has one, in either direction, so a descending date sort starts
 * with the newest title rather than the undated ones. Ties fall through to the
 * next term and finally to catalog order, so the result is stable and a page
 * boundary never moves between requests.
 */
export function sortCatalogEntries(
  entries: MetaPreview[],
  terms: LibrarySortTerm[]
): MetaPreview[] {
  if (!terms.length || entries.length < 2) return [...entries];
  const decorated = entries.map((entry, index) => {
    let enrichment: Enrichment | undefined;
    const lazy = () => (enrichment ??= readEnrichment(entry));
    return {
      entry,
      index,
      values: terms.map((t) => valueOf(t.key, entry, lazy)),
    };
  });
  decorated.sort((a, b) => {
    for (const [i, term] of terms.entries()) {
      const x = a.values[i];
      const y = b.values[i];
      const xMissing = x === undefined || x === '';
      const yMissing = y === undefined || y === '';
      if (xMissing || yMissing) {
        if (xMissing && yMissing) continue;
        return xMissing ? 1 : -1;
      }
      const c = compareValues(x, y);
      if (c) return term.descending ? -c : c;
    }
    return a.index - b.index;
  });
  return decorated.map((d) => d.entry);
}
