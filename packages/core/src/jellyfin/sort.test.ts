import { before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the dependency graph.
import '../index.js';
import { settingsStore } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import type { MetaPreview } from '../db/schemas.js';
import type { AIOStreams } from '../main/index.js';
import type { Catalog } from './dto.js';
import { getCatalogPage } from './library.js';
import { parseLibrarySort, sortCatalogEntries } from './sort.js';

function entry(
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
): MetaPreview {
  return { id, type: 'movie', name, ...extra } as MetaPreview;
}

const ids = (list: MetaPreview[]) => list.map((e) => e.id);

describe('parseLibrarySort', () => {
  it('keeps catalog order when nothing, Random or Default comes first', () => {
    assert.equal(parseLibrarySort([], []), null);
    assert.equal(parseLibrarySort(['Random'], ['Ascending']), null);
    assert.equal(parseLibrarySort(['Default', 'SortName'], []), null);
  });

  it('keeps catalog order when no key is one an entry can answer', () => {
    assert.equal(parseLibrarySort(['DatePlayed', 'PlayCount'], []), null);
  });

  it('pairs orders with keys and fills the rest from the first order', () => {
    assert.deepEqual(
      parseLibrarySort(['PremiereDate', 'SortName'], ['Descending']),
      [
        { key: 'premieredate', descending: true },
        { key: 'sortname', descending: true },
      ]
    );
    assert.deepEqual(
      parseLibrarySort(
        ['CommunityRating', 'SortName'],
        ['Descending', 'Ascending']
      ),
      [
        { key: 'communityrating', descending: true },
        { key: 'sortname', descending: false },
      ]
    );
  });

  it('defaults to ascending, is case-insensitive and maps Name to SortName', () => {
    assert.deepEqual(parseLibrarySort(['name'], []), [
      { key: 'sortname', descending: false },
    ]);
  });

  it('skips unknown and repeated keys and stops at Default', () => {
    assert.deepEqual(
      parseLibrarySort(
        ['IsFolder', 'ProductionYear', 'productionyear', 'Default', 'Runtime'],
        []
      ),
      [{ key: 'productionyear', descending: false }]
    );
  });
});

describe('sortCatalogEntries', () => {
  const catalog = [
    entry('tt1', 'The Zebra', {
      released: '2001-05-01T00:00:00.000Z',
      imdbRating: '6.1',
      runtime: '90 min',
    }),
    entry('tt2', 'alpha', {
      released: '2019-01-01T00:00:00.000Z',
      imdbRating: '8.4',
      runtime: '120 min',
    }),
    entry('tt3', 'Movie 10', { releaseInfo: '2010', imdbRating: '7.0' }),
    entry('tt4', 'Movie 9', { releaseInfo: '2010-2012' }),
    entry('tt5', 'Élan', {
      released: '2023-07-04T00:00:00.000Z',
      imdbRating: '7.0',
    }),
  ];

  it('sorts by name with accents folded and numbers in numeric order', () => {
    const sorted = sortCatalogEntries(
      catalog,
      parseLibrarySort(['SortName'], ['Ascending'])!
    );
    assert.deepEqual(ids(sorted), ['tt2', 'tt5', 'tt4', 'tt3', 'tt1']);
    const reversed = sortCatalogEntries(
      catalog,
      parseLibrarySort(['SortName'], ['Descending'])!
    );
    assert.deepEqual(ids(reversed), ['tt1', 'tt3', 'tt4', 'tt5', 'tt2']);
  });

  it('puts entries without a premiere date last in both directions', () => {
    const desc = sortCatalogEntries(
      catalog,
      parseLibrarySort(['PremiereDate'], ['Descending'])!
    );
    assert.deepEqual(ids(desc), ['tt5', 'tt2', 'tt1', 'tt3', 'tt4']);
    const asc = sortCatalogEntries(
      catalog,
      parseLibrarySort(['DateCreated'], ['Ascending'])!
    );
    assert.deepEqual(ids(asc), ['tt1', 'tt2', 'tt5', 'tt3', 'tt4']);
  });

  it('reads the year the item shows, from released or releaseInfo', () => {
    const sorted = sortCatalogEntries(
      catalog,
      parseLibrarySort(['ProductionYear'], ['Descending'])!
    );
    // tt3 and tt4 share 2010 and keep catalog order.
    assert.deepEqual(ids(sorted), ['tt5', 'tt2', 'tt3', 'tt4', 'tt1']);
  });

  it('breaks ties with the next key, then with catalog order', () => {
    const byRating = sortCatalogEntries(
      catalog,
      parseLibrarySort(['CommunityRating'], ['Descending'])!
    );
    // tt3 and tt5 tie at 7.0: catalog order; tt4 has no rating.
    assert.deepEqual(ids(byRating), ['tt2', 'tt3', 'tt5', 'tt1', 'tt4']);
    const thenName = sortCatalogEntries(
      catalog,
      parseLibrarySort(
        ['CommunityRating', 'SortName'],
        ['Descending', 'Ascending']
      )!
    );
    // Now the tie goes to the name: "Élan" before "Movie 10".
    assert.deepEqual(ids(thenName), ['tt2', 'tt5', 'tt3', 'tt1', 'tt4']);
  });

  it('sorts by runtime and critic rating when the entries carry them', () => {
    const runtime = sortCatalogEntries(
      catalog,
      parseLibrarySort(['Runtime'], ['Descending'])!
    );
    assert.deepEqual(ids(runtime).slice(0, 2), ['tt2', 'tt1']);
    const critic = sortCatalogEntries(
      [
        entry('a', 'A'),
        entry('b', 'B', {
          app_extras: { ratings: [{ source: 'tomatoes', value: 91 }] },
        }),
        entry('c', 'C', { criticRating: 95 }),
      ],
      parseLibrarySort(['CriticRating'], ['Descending'])!
    );
    assert.deepEqual(ids(critic), ['c', 'b', 'a']);
  });

  it('does not change the input array', () => {
    const copy = [...catalog];
    sortCatalogEntries(catalog, parseLibrarySort(['SortName'], [])!);
    assert.deepEqual(ids(catalog), ids(copy));
  });
});

describe('getCatalogPage maxRead', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });

  const PAGE = 20;
  const TOTAL = 95;
  const catalogDef = {
    type: 'movie',
    id: 'test.sorted',
    name: 'Sorted',
    extra: [{ name: 'skip' }],
  } as Catalog;

  function fakeEngine() {
    const skips: number[] = [];
    const engine = {
      async getCatalog(_type: string, _id: string, extras?: string) {
        const skip = Number(/skip=(\d+)/.exec(extras ?? '')?.[1] ?? 0);
        skips.push(skip);
        const data: MetaPreview[] = [];
        for (let i = skip; i < Math.min(skip + PAGE, TOTAL); i++)
          data.push(entry(`tt${1000 + i}`, `Title ${TOTAL - i}`));
        return { success: true, data, errors: [] };
      },
    } as unknown as AIOStreams;
    return { engine, skips };
  }

  it('reads the whole catalog when it fits, so a sort sees every entry', async () => {
    const { engine } = fakeEngine();
    const all = await getCatalogPage(engine, catalogDef, {
      startIndex: 0,
      limit: 1000,
      maxRead: 1000,
    });
    assert.equal(all.items.length, TOTAL);
    assert.equal(all.hasMore, false);
    const sorted = sortCatalogEntries(
      all.items,
      parseLibrarySort(['SortName'], [])!
    );
    // Names count down, so name order is the reverse of catalog order.
    assert.equal(sorted[0].id, `tt${1000 + TOTAL - 1}`);
    assert.equal(sorted[TOTAL - 1].id, 'tt1000');
  });

  it('stops reading at maxRead and reports the capped set as complete', async () => {
    const { engine, skips } = fakeEngine();
    const page = await getCatalogPage(engine, catalogDef, {
      startIndex: 0,
      limit: 40,
      maxRead: 40,
    });
    assert.equal(page.items.length, 40);
    assert.equal(page.total, 40);
    assert.equal(page.hasMore, false);
    assert.ok(Math.max(...skips) < 40, `read past the cap: ${skips}`);
  });
});
