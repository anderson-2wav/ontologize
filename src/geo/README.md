# ontologize/geo

Geospatial helpers for the **cell-cache** architecture used by BOLD's
`GeoView` and `ResourceGeoView` components — a way to render large
location datasets on a tiled web map by partitioning docs into H3 cells
(and, at coarse zooms, geohash cells) and fetching only the cells that
intersect the current viewport.

License: **LGPL-3.0-or-later** (same as the rest of `ontologize`).

---

## Files in this directory

| File | Pure? | Purpose |
|------|-------|---------|
| `geohash.js` | yes (`ngeohash`) | Viewport → geohash precision and cell coverage. |
| `h3.js` | yes (`h3-js`) | H3 resolution policy, stored-field naming, viewport → cells. |
| `cellFetcher.js` | server (Mongo) | Raw-or-cluster fetcher: per-cell aggregation with per-group sub-clusters and time-presence buckets. |
| `addH3.js` | server (Mongo) | One-shot ingest helper: backfill `_h3` + parent-resolution fields on a collection and ensure their indexes. |
| `index.js` | re-export | Entry for `ontologize/geo` (geohash + h3). |
| `server.js` | re-export | Entry for `ontologize/geo-server` (cellFetcher + addH3). |

"Pure" means no Mongo, no Meteor, no node built-ins — safe to import
from a browser bundle.

---

## How to import

The package exposes two sub-path exports in `package.json`:

```js
import { bboxToH3Cells, zoomToH3Resolution } from "ontologize/geo";
import { getDocsInCell } from "ontologize/geo-server";
```

> **Meteor caveat.** Meteor's bundler doesn't honor `"exports"` subpaths
> in every configuration. If `ontologize/geo` doesn't resolve at build
> time, use the path-style import the rest of the BOLD app uses:
>
> ```js
> import { bboxToH3Cells } from "/modules/ontologize/src/geo/index.js";
> import { getDocsInCell } from "/modules/ontologize/src/geo/server.js";
> ```

---

## `ontologize/geo` — pure helpers

### `geohash.js`

```js
bboxToPrecision(bbox) → number    // geohash char length for a viewport
incPrefix(prefix)     → string    // exclusive upper bound for a prefix range
expandedRegionCells(bounds) → { cells: string[], precision: number }
                                  //   covering cells + 1-ring buffer
```

`bounds` is `{N, S, W, E}`; `bbox` is `{minLat, maxLat, minLng, maxLng}`.

### `h3.js`

```js
FINE_RESOLUTION       = 15
PARENT_RESOLUTIONS    = [3, 5, 7, 9, 11]
STORED_RESOLUTIONS    = [3, 5, 7, 9, 11, 15]

h3FieldName(resolution) → "_h3" | "_h3_3" | "_h3_5" | ...
zoomToH3Resolution(leafletZoom) → 3 | 5 | 7 | 9 | 11
bboxToH3Cells(bbox, resolution) → string[]    // covering hexes
bufferRing(cellIds, k = 1)      → string[]    // k-ring union
```

`zoomToH3Resolution` is calibrated to keep a typical 1200×800 viewport
under ~200 covering cells — see the table in `h3.js`'s JSDoc for the
zoom → resolution → expected-cell-count breakdown.

---

## `ontologize/geo-server` — cell fetcher

```js
getDocsInCell({
  ontologize,        // Ontologize instance — used only for .collections[name]
  collection,        // string key into ontologize.collections
  baseSelector = {}, // extra Mongo selector AND-ed with the cell match
  cellId,            // H3 cell at any stored resolution
  maxRaw = 1000,     // count above this returns a cluster instead of raw docs
  groupProperty,     // when set, cluster includes per-group sub-clusters
}) → Promise<CellResponse>

getDocsInCells({ ontologize, collection, baseSelector, cellIds, maxRaw, groupProperty })
  → Promise<{ results: Record<cellId, CellResponse> }>
```

`CellResponse`:

```ts
{
  cellId: string,
  resolution: 3 | 5 | 7 | 9 | 11 | 15,
  count: number,
  shape: "raw" | "cluster",
  docs?: object[],   // when shape = "raw"
  cluster?: {        // when shape = "cluster"
    centroid:  { lat, lng },
    timeRange: { startMs, endMs } | null,
    groupClusters?: Array<{
      groupId, count, centroid, timeRange,
      buckets: Array<{ minMs, maxMs } | null>   // length 16, or 1 zero-span
    }>
  }
}
```

The `buckets` array is the per-group time-presence index used by
TimePathPlugin's bucket-aware "is this animal actually here at time `t`"
check — see the JSDoc on `binTimes` in `cellFetcher.js`.

### `addH3.js` — ingest backfill

```js
addH3({
  ontologize,    // Ontologize instance — used only for .collections[name]
  collection,    // string key into ontologize.collections
  force = false, // recompute even when _h3 is already set
}) → Promise<{ updated, skipped, indexed: string[], durationMs }>

// And a constant listing the field names the routine writes + indexes:
ADD_H3_FIELDS = ["_h3", "_h3_3", "_h3_5", "_h3_7", "_h3_9", "_h3_11"]
```

Run once after any data import that introduces geo-located docs without
H3 cells. Idempotent — docs that already have `_h3` are skipped unless
`force` is true. Creates the per-field indexes as a side effect
(`createIndex` is a no-op when the index already exists).

In the BOLD app this is wrapped by the `geo.addH3` Meteor method
(`server/methods/geo-addH3.js`), which adds Meteor.Error translation
for client callers.

### The `ontologize` parameter

`cellFetcher` is library code — it doesn't know about your app's
collections. It looks them up by name through the passed-in `ontologize`
instance's `.collections` registry, populated at app startup. Any object
with a `.collections` map works (the library only reads
`ontologize.collections[name]`), which makes the fetcher easy to test
without booting a full `OntologizeServer`:

```js
const ontologize = { collections: { track: Track.rawCollection() } };
await getDocsInCell({ ontologize, collection: "track", cellId, ... });
```

Each collection value must be a MongoDB-driver-shaped `Collection` —
i.e. one whose `find()` and `aggregate()` return cursors with `.toArray()`.
A Meteor `Collection`'s `.rawCollection()` qualifies; so does anything
returned by `MeteorCollectionAdapter` (the shape OntologizeServer uses
throughout).

### Error shape

The library throws plain `Error`s. Callers branch on message prefix
when they need to map to HTTP status codes etc.:

| Prefix | Meaning |
|--------|---------|
| `Unknown collection "<name>"` | `name` not registered in `ontologize.collections`. |
| `Invalid H3 cell: <id>`       | `cellId` failed `h3.isValidCell()`. |
| `geoH3: no stored field …`    | Cell's resolution isn't in `STORED_RESOLUTIONS`. |
| `cellIds must be an array`    | `getDocsInCells` got a non-array. |

If you want typed errors instead of string-matching, exporting named
`Error` subclasses from this file is the obvious next step — currently
deferred until there's more than one caller doing the mapping.

---

## Preparing your data

`cellFetcher` only works against docs that already have `_h3` plus the
parent-resolution fields (`_h3_3, _h3_5, _h3_7, _h3_9, _h3_11`). The
`addH3` helper writes those fields and creates the matching indexes for
you, given docs that carry `geo:lat` + `geo:long`.

**Prerequisites:**
- Docs that should be indexed have numeric `geo:lat` and `geo:long`.
  Docs missing either are silently counted under `skipped`.
- A MongoDB driver-shaped `Collection` reachable via your `ontologize`
  instance under a known string name (see [The `ontologize` parameter](#the-ontologize-parameter)).

### Plain-Node walkthrough (any consumer)

```js
import { MongoClient } from "mongodb";
import { addH3 } from "ontologize/geo-server";

const client = new MongoClient(process.env.MONGO_URL);
await client.connect();
const db = client.db();

// Minimal duck-typed Ontologize: addH3 only reads .collections[name].
// You can also pass a real OntologizeServer instance and skip this.
const ontologize = {
  collections: {
    track:  db.collection("track"),
    animal: db.collection("animal"),
    // …any other geo-located collections you intend to render
  },
};

// One call per collection. Idempotent — re-running reports updated:0.
const result = await addH3({ ontologize, collection: "track" });
console.log(result);
// { updated: 12345, skipped: 0,
//   indexed: ["_h3", "_h3_3", "_h3_5", "_h3_7", "_h3_9", "_h3_11"],
//   durationMs: 4218 }

// Use force:true to recompute every doc — e.g. after changing your
// STORED_RESOLUTIONS or recovering from a partial write.
await addH3({ ontologize, collection: "track", force: true });
```

**When to run it.** Once after each data import that introduces new
geo-located docs. The operation is safe to run repeatedly — only docs
without an `_h3` are touched (unless `force` is set), and the index
creations are no-ops once the indexes exist.

### Meteor / BOLD example (one way to wrap it)

The BOLD app exposes the same operation as a Meteor method so admins
can trigger backfills from the UI. The wrapper at
`server/methods/geo-addH3.js` is the canonical pattern for a Meteor
consumer:

```js
// 1) At app startup, register your collections on the OntologizeServer
//    singleton (see imports/startup/server/index.js for a full example):
OntologizeServer.initialize(
  Ontology.rawCollection(), Context.rawCollection(), Statements.rawCollection(),
  { collections: { track: Track.rawCollection(), /* … */ } },
);

// 2) Define the Meteor method as a thin call into addH3():
Meteor.methods({
  async "geo.addH3"({ collection, force = false }) {
    return addH3({ ontologize: OntologizeServer.get(), collection, force });
  },
});

// 3) From the client or an admin script:
const result = await Meteor.callAsync("geo.addH3", { collection: "track" });
```

The wrapper in BOLD also translates the library's plain `Error("Unknown
collection …")` into a `Meteor.Error` so client callers see the original
message instead of "Internal server error" — handy, but only relevant if
your consumer is Meteor.

---

## Data-model contract

`cellFetcher` assumes each doc carries:

- `_h3`               — the fine (res 15) H3 cell id
- `_h3_3, _h3_5, _h3_7, _h3_9, _h3_11` — parent-cell ids at the stored
  resolutions
- `_whenMs`           — timestamp (epoch ms), used for `timeRange` and
  the time-presence buckets
- `geo:lat`, `geo:long` — used for cluster centroid (`$avg`)

The first two bullets are what [`addH3`](#preparing-your-data) writes. `_whenMs` and `geo:lat/long` are your responsibility at ingest
time. The time bucketing logic lives in `cellFetcher.js` under
`binTimes`.

---

