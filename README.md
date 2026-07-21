# Ontologize

Ontologize is the core API of BOLD for working with ontology data in MongoDB. It provides tools for importing, managing, and querying JSON-LD ontologies and instance data (ABox) with full OWL compatibility.

Ontologize borrows heavily from concepts developed for CyberTalent Bridge™, a cyber-security workforce planning tool created with generous support of U.S. Department of Homeland Security under Grant Award Number, 2015-ST-061-CIRC01. The code has been entirely rewritten to be framework and application agnostic.

Ontologize is a component of the BOLD stack (Bridge Ontology Linked Data). It handles:
- **TBox/ABox separation:** Ontology definitions (classes, properties) are stored separately from instance data
- **Context management:** Application-wide JSON-LD @context stored and merged automatically
- **Namespace collections:** Domain-specific data organized into separate MongoDB collections by namespace
- **RDF Statements:** Reification support for property metadata (provenance, timestamps, etc.)
- **Resource normalization:** All resources compacted to MongoDB-safe format via the `bold-ld` module

The Ontologize module provides two distinct imports: `Ontologize` is intended for use on both client and server, `OntologizeServer` is only available on the server. The client-side implementation of `Ontologize` is largely intended for MeteorJS applications, where mini-mongo collections are available on the client. For other frameworks, the complete Ontologize API is available to `OntologizeServer` — and the client-side `Ontologize` can be run in a non-Meteor browser (e.g. a Nuxt SPA) by backing its collections with HTTP. See [Using Ontologize in a non-Meteor client](#using-ontologize-in-a-non-meteor-client-nuxt).

## License

Ontologize is licensed under the **GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later)**.

This means:
- If you modify Ontologize source files, share those changes under LGPL. (PRs would be nice.)
- Your application code that uses Ontologize can remain proprietary
- See [LICENSE](./LICENSE) for full terms

## Core Concepts

### BOLD Collections

Three collections are built into every BOLD application:

| Collection | MongoDB Name | Purpose |
|------------|--------------|---------|
| Ontology | `ontology` | TBox resources (classes, properties, ontology definitions) |
| Context | `context` | Global JSON-LD @context (singleton at `_id: "@id"`) |
| Statements | `statements` | RDF Statement reifications for property metadata |

### Namespace Collections

Ontologize can be initialized with additional named collections, where the collection name is conventionally the QName prefix for a namespace.

```javascript

// ES Module imports
import { Ontologize } from "ontologize"; // client and server

// Create an instance with MongoDB collections
const ontologize = new Ontologize(
  ontologyCollection,    // TBox resources (classes, properties)
  contextCollection,     // Global @context
  statementsCollection,  // RDF Statement reifications
  {
    collections: {
      myapp: myAppCollection  // Namespace collection for ABox data with the "myapp" prefix
    }
  }
);
```

When resources are imported by Ontologize, domain-specific ABox data is stored in the collections named by namespace prefix:
```javascript
// Resources with prefix "myapp:" go to the "myapp" collection
const aboxResource = {
  "_id": "myapp:person-1",
  "@type": ["foaf:Person"],
  "foaf:name": "Jane Doe"
}
```

### Type Collections
It is occasionally useful to store specific types of resources in a collection dedicated to that type. Consider a hypothetical scientific application in which many instances of "bold:Species" may be imported from sources with different namespaces. Ontologize can automatically import all bold:Species into the "species" collection.

```javascript
// Create an instance with specific collections for "bold:Species" resources
const ontologize = new Ontologize(
  ontologyCollection,    // TBox resources (classes, properties)
  contextCollection,     // Global @context
  statementsCollection,  // RDF Statement reifications
  {
    collections: {
      myapp: myAppCollection  // Namespace collection for ABox data with the "myapp" prefix
    },
    typeCollections: {
      "bold:Species": "species" // collection for ABox data with the type "bold:Species"
    },
  }
);
```

#### Default ABox Collection
`opts.typeCollections` can use a "*" key to delegate a "catch-all" collection for ABox individuals that don't resolve to any namespace, `typeCollections` or `idResolvers` collection.

```js
opts = {
   "typeCollections": {
      "*": "abox"
   }
}
```



### ID Resolvers
Resources can be routed to specific collections based on recognized patterns in @id for a particular namespace:

```javascript
const ontologize = new Ontologize(
  ontologyCollection,
  contextCollection,
  statementsCollection,
  {
    collections: {
      myapp: myAppCollection,
      animal: animalCollection
    },
    idResolvers: {
      "myapp": [
        { match: "animal-", collection: "animal" }
      ]
    }
  }
);

// "myapp:animal-fido" -> saved to animalCollection
// "myapp:person-jane" -> saved to myAppCollection (default)
```

### Resource Format

BOLD resources are normalized JSON-LD documents, compacted with `ld.compact`:

```json
{
  "_id": "foaf:Person",
  "@type": ["owl:Class"],
  "rdfs:label": "Person",
  "rdfs:subClassOf": ["foaf:Agent"]
}
```

### RDF Statements
The `statements` collection contains resources of type "rdf:Statement", which contain metadata about assertions in BOLD resources, identified by subject, predicate and object. 

```js
// a minimal resourc with just one assertion
const resource = {
  "@id": "myapp:person-1",
  "foaf:name": "Jane Doe"
}

// A statement about when and where the foaf:name assertion came from
const statementAboutJanesName = {
  "_id": "bold:stmt-12345",
  "@type": ["rdf:Statement"],
  "rdf:subject": "myapp:person-1",
  "rdf:predicate": "foaf:name",
  "rdf:object": "Jane Doe",
  "bold:when": "2024-01-15T10:30:00Z",
  "bold:provenance": "myapp:import-batch-1"
}
```

Statements are automatically detected by `ontologizeServer.importData` and saved to the statements collection. It can be useful to include `rdf:Statement`s in data imports to provide metadata about relationships in the data.

For example, our BOLD demo: 
- uses [Basic Formal Ontology](https://basic-formal-ontology.org) (BFO) to model core concepts independent of knowledge domain.
- uses the [Darwin Core](https://dwc.tdwg.org) ontology to model certain biology data.
- an LLM process was used to create `rdfs:subClassOf` mappings from Darwin Core to BFO. We call this a "bridge ontology", identified in this case by the URI "dwcbfo:dwcbfo.owl".
- an `rdf:Statement` in the "dwcbfo:dwcbfo.owl" ontology documents each subclass relationship, where it comes from (bold:provenance), and "rdfs:comment" to explain the model's reasoning for the relationship.

```javascript
const statementAboutSubclassRelation = {
  _id: "dwcbfo:dwc-bfo-statement-16", 
  "@type": [ "rdf:Statement" ],
  "rdf:subject": "dwc:MeasurementOrFact",
  "rdf:predicate": "rdfs:subClassOf",
  "rdf:object": "bfo:generically-dependent-continuant",
  "dcterms:isPartOf": "dwcbfo:dwcbfo.owl",
  "bold:provenance": "CLAUDE Code",
  "rdfs:comment": "A measurement or fact is 'information pertaining to measurements, facts, characteristics, or assertions' - recorded data with provenance (who measured, when, how)."
};
```

## Usage

### Installation

```bash
# TBD! Ontologize is not yet available on npm.
npm install ontologize
```

### Basic Setup

```javascript
// ES Module imports
import { Ontologize } from "ontologize"; // client and server
import { OntologizeServer } from "ontologize/server";  // server-only

// Create an instance with MongoDB collections
const ontologize = new Ontologize(
  ontologyCollection,    // TBox resources (classes, properties)
  contextCollection,     // Global @context
  statementsCollection,  // RDF Statement reifications
  {
    collections: {
      myapp: myAppCollection  // Namespace collection for ABox data
    }
  }
);
```

### Singleton Pattern
For application-wide use, initialize once and access everywhere:

```javascript
// Server startup
import { OntologizeServer } from "ontologize/server";

OntologizeServer.initialize(
  ontologyCollection,
  contextCollection,
  statementsCollection,
  { collections: { myapp: myAppCollection } }
);

// Later, anywhere in server code
const ontologize = OntologizeServer.get();
```

### Importing JSON-LD Data

```javascript
import { OntologizeServer } from "ontologize/server";

const ontologize = OntologizeServer.get();

// Import from file
const result = await ontologize.importFromFile(
  "/path/to/ontology.jsonld",
  { ontologize: true }  // merge TBox resources into ontology collection
);

// Import from parsed data
const data = {
  "@context": { "foaf": "http://xmlns.com/foaf/0.1/" },
  "@graph": [
    {
      "@id": "foaf:Person",
      "@type": ["owl:Class"],
      "rdfs:label": "Person"
    }
  ]
};

await ontologize.importData(data, { ontologize: true });
```

### Filtering Imports
Use `beforeSaveFn` to filter or modify resources during import:

```javascript
await ontologize.importData(data, {
  ontologize: true,
  beforeSaveFn: (resource) => {
    // Add provenance to all imported resources
    resource["dcterms:isPartOf"] = "myapp:imported-ontology";

    // Return falsy to skip a resource
    if (resource["@id"].startsWith("skip:")) {
      return null;
    }

    return resource;
  }
});
```

### Context Management
Ontologize maintains a global JSON-LD context in the "context" collection with `_id: "@id"`. `ontologize.importContext` will merge any JSON-LD context into the global context. The global context can be accessed with `ontologize.getContext`.

You don't usually need to call `ontologize.importContext` directly, because functions like `ontologize.importData` will detect "@context" in imported data and automatically merge incoming context into the global context.

Most Ontologize functions which require a JSON-LD context will use the global context by default.  

```javascript
// Merge new prefixes into global context
await ontologize.importContext({
  "myapp": "https://example.org/myapp#",
  "schema": "https://schema.org/"
});

// Retrieve the global context
const context = await ontologize.getContext();
// context.myapp -> "https://example.org/myapp#"
```

## Using Ontologize in a non-Meteor client (Nuxt)

The client-side `Ontologize` needs collections, but a non-Meteor browser has no
Minimongo to give it. `HttpCollectionAdapter` fills that gap: it presents the
collection interface Ontologize expects while fetching documents from a small
HTTP service instead of a local store. This is what lets the `bold-vue`
resource-display components (`ResourceViewer`, `ResourceList`, `ResourceBrowser`,
…) render in a Nuxt SPA.

The adapter is deliberately narrow. Every read the display components make bottoms
out in `findOne({ _id })` — label and schema resolution walk the class hierarchy by
id, and resource lookups are by id — so the wire contract is **id-addressed and
read-only**. There are no caller-supplied selectors, and therefore no
query-injection surface. Cursor and aggregate methods throw rather than degrade.

Two pieces cooperate:

- **`ontologize/http`** — `createCollectionHandler`, a host-agnostic request
  handler you mount on your server.
- **`ontologize/adapters`** — `HttpCollectionAdapter`, the client-side collection
  that talks to it.

### Server: mount the document handler (Nitro)

`createCollectionHandler` takes an allowlist of collections and returns a plain
`async ({ method, kind, collection, id }) => { status, body }`. It knows nothing
about H3, Express, or Connect, so you adapt it to your server in a few lines. In
Nuxt, a catch-all Nitro route does it:

```javascript
// server/api/bold/[...].js  (Nitro)
import { createCollectionHandler } from "ontologize/http";
import { getMongoCollection } from "../../utils/mongo"; // your driver handle

const handle = createCollectionHandler({
  collections: {
    ontology:   () => getMongoCollection("ontology"),
    context:    () => getMongoCollection("context"),
    statements: () => getMongoCollection("statements"),
    species:    () => getMongoCollection("species"),
    // …your ABox collections
  },
  // Only these may be dumped whole (see seedAll below). Keep it to the small,
  // near-immutable TBox collections.
  allowBulk: ["ontology", "context"],
});

export default defineEventHandler(async (event) => {
  // URL shape: /api/bold/doc/:collection/:id  |  /api/bold/docs/:collection
  const [kind, collection, id] = event.context.params._.split("/").map(decodeURIComponent);
  const { status, body } = await handle({ method: event.method, kind, collection, id });
  setResponseStatus(event, status);
  return body;
});
```

The wire contract is two routes:

| Request | Returns |
|---|---|
| `GET /api/bold/doc/:collection/:id` | `{ doc }`, or `404` |
| `GET /api/bold/docs/:collection` | `{ docs: [...] }` (bulk; opt-in per collection via `allowBulk`) |

An allowlist entry may be a collection handle or a thunk returning one (deferred
resolution, handy when the driver connects lazily). The handler adds no
authentication — put your auth in front of it.

### Client: build Ontologize from HTTP adapters (Nuxt plugin)

Construct one adapter per collection, seed the TBox once, then initialize
Ontologize and wait for its context to load. A Nuxt plugin is the natural home,
so the instance is ready before any component renders:

```javascript
// plugins/ontologize.client.js
import Ontologize from "ontologize";
import { HttpCollectionAdapter } from "ontologize/adapters";

export default defineNuxtPlugin(async () => {
  // One shared cache Map backs every adapter, keyed by collection+id.
  const cache = new Map();
  const opts = { baseUrl: "/api/bold", cache };

  const ontology   = new HttpCollectionAdapter("ontology",   opts);
  const context    = new HttpCollectionAdapter("context",    opts);
  const statements = new HttpCollectionAdapter("statements", opts);

  // Pull the whole TBox in one request each. Afterwards, class-hierarchy
  // walks (getLabel, getSchema, …) resolve from memory — zero network traffic.
  await ontology.seedAll();
  await context.seedAll();

  const ontologize = Ontologize.initialize(ontology, context, statements, {
    collections: {
      species: new HttpCollectionAdapter("species", opts),
      // …your ABox collections
    },
  });

  // REQUIRED: the context loads asynchronously over HTTP, and ld() throws
  // until it has. Always await ready() before rendering.
  await ontologize.ready();

  return { provide: { ontologize } };
});
```

Then pass `$ontologize` as the `ontologize` prop to the display components.

### Three things to get right

1. **Always `await ontologize.ready()`.** Because `findOne` is asynchronous over
   HTTP, the JSON-LD context — and therefore the internal `LD` instance — loads a
   tick after `initialize()`. `ld()` throws a clear error if called before then,
   rather than silently producing uncompacted output. (In Meteor, where Minimongo
   answers synchronously, `ready()` resolves immediately and this is a no-op.)

2. **Seed the TBox; don't fetch it per id.** `seedAll()` on `ontology` and
   `context` turns a deep class-hierarchy walk into memory hits. Without it, the
   first render of a resource is a waterfall of per-class round trips. The one
   caveat: RDF meta-classes not present in your ontology dump (e.g. `rdfs:Class`)
   still incur a single lookup each, which is then negatively cached — so a second
   render is free either way.

3. **`ResourceList` needs its `resources` prop.** That component runs its own
   collection cursors for server-side pagination, which `HttpCollectionAdapter`
   does not support (`find`/`aggregate` throw). In a non-Meteor host, fetch and
   paginate in your page and hand the page's slice to `ResourceList` via the
   `resources` prop; it then skips collection access entirely.

### Server methods (JsonViewer save, etc.)

A few `bold-vue` components invoke named server methods (e.g. `JsonViewer`'s save).
That is a `bold-vue` concern rather than an Ontologize one: register a transport
once at startup with `setRpcTransport` from `bold-vue/rpc.js`, pointing it at your
Nitro endpoints. Ontologize itself has no such dependency.

The complete design — wire contract, caching and coalescing semantics, and the
readiness rationale — is documented in
`.private/specs/http-collection-adapter-spec.md`.

## TypeScript Support

The module includes comprehensive TypeScript declarations:

```typescript
import Ontologize, {
  OntologizeOptions,
  Resource,
  OntologyResource
} from "ontologize";

import {
  OntologizeServer,
  ImportOptions,
  ImportResult
} from "ontologize/server";

const ontologize: Ontologize = new Ontologize(
  ontologyCollection,
  contextCollection,
  statementsCollection,
  options
);
```

**Available types from `ontologize`:**
- **`Ontologize`** - Main class (default export)
- **`OntologizeOptions`** - Constructor options interface
- **`Resource`** - Generic JSON-LD resource type
- **`OntologyResource`** - Resource with required `@id` and `@type`
- **`MongoCollection`** - MongoDB collection interface
- **`GetLabelOptions`** - Options for `getLabel()` method
- **`GetLocationOptions`** - Options for `getGeoJSON()` method
- **`FormatDateOptions`** - Options for `formatDate()` and `formatDateTime()`
- **`SunriseSunsetResponse`** - Return type for `getSunriseSunset()`
- **`GeoJSONPoint`**, **`GeoJSONGeometry`** - GeoJSON location types

**Available types from `ontologize/server`:**
- **`OntologizeServer`** - Server-side class with import/bootstrap capabilities
- **`ImportOptions`** - Options for `importData()` and `importFromFile()`
- **`ImportResult`** - Result object from import operations

## Related Modules

- **[bold-ld](../bold-ld)** - JSON-LD processing, compaction, and proxy objects
- **[hylar-reasoner](../hylar-reasoner)** - OWL reasoning server

