# Ontologize

Ontologize is the core API of BOLD for working with ontology data in MongoDB. It provides tools for importing, managing, and querying JSON-LD ontologies and instance data (ABox) with full OWL compatibility.

Ontologize is a component of the BOLD stack (Bridge Ontology Linked Data). It handles:
- **TBox/ABox separation:** Ontology definitions (classes, properties) are stored separately from instance data
- **Context management:** Application-wide JSON-LD @context stored and merged automatically
- **Namespace collections:** Domain-specific data organized into separate MongoDB collections by namespace
- **RDF Statements:** Reification support for property metadata (provenance, timestamps, etc.)
- **Resource normalization:** All resources compacted to MongoDB-safe format via the `bold-ld` module

## License

Ontologize is licensed under the **Mozilla Public License 2.0 (MPL-2.0)**.

This means:
- If you modify Ontologize source files, share those changes
- Your application code that uses Ontologize can remain proprietary
- See [LICENSE](./LICENSE) for full terms

## Installation

TBD: Ontologize is not yet available on npm.
```bash
npm install ontologize
```

## Usage

### Basic Setup

```javascript
// ES Module imports
import { Ontologize } from "ontologize";
import { OntologizeServer } from "ontologize/server";  // Server-only

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

```javascript
// Merge new prefixes into global context
await ontologize.importContext({
  "myapp": "https://example.org/myapp#",
  "schema": "https://schema.org/"
});

// Retrieve the global context
const context = await ontologize.getContext();
```

### TBox vs ABox Detection

```javascript
// Check if a resource is a TBox resource (class, property, ontology)
const isTBox = Ontologize.isTBoxResource(resource);

// Returns true for:
// - @type includes owl:Class, rdfs:Class
// - @type includes owl:ObjectProperty, owl:DatatypeProperty, rdf:Property
// - @type includes owl:Ontology
// - Resource has rdfs:subClassOf, rdfs:domain, rdfs:range
```

### Statement Detection

```javascript
// Check if a resource is an RDF Statement
const isStatement = Ontologize.isStatementResource(resource);

// Returns true for:
// - @type includes rdf:Statement
// - Resource has rdf:subject, rdf:predicate, rdf:object
```

### ID Resolvers

Route resources to specific collections based on @id patterns:

```javascript
const ontologize = new Ontologize(
  ontologyCollection,
  contextCollection,
  statementsCollection,
  {
    collections: {
      myapp: myAppCollection,
      species: speciesCollection,
      animal: animalCollection
    },
    idResolvers: {
      "myapp": [
        { match: "species-", collection: "species" },
        { match: "animal-", collection: "animal" }
      ]
    }
  }
);

// "myapp:species-dog" -> saved to speciesCollection
// "myapp:animal-fido" -> saved to animalCollection
// "myapp:person-jane" -> saved to myAppCollection (default)
```

## Core Concepts

### BOLD Collections

Three collections are built into every BOLD application:

| Collection | MongoDB Name | Purpose |
|------------|--------------|---------|
| Ontology | `ontology` | TBox resources (classes, properties, ontology definitions) |
| Context | `context` | Global JSON-LD @context (singleton at `_id: "@id"`) |
| Statements | `statements` | RDF Statement reifications for property metadata |

### Namespace Collections

Domain-specific ABox data is stored in separate collections named by namespace prefix:

```javascript
// Resources with prefix "myapp:" go to the "myapp" collection
{
  "_id": "myapp:person-1",
  "@type": ["foaf:Person"],
  "foaf:name": "Jane Doe"
}
```

### Resource Format

BOLD resources are normalized JSON-LD documents:

```json
{
  "_id": "foaf:Person",
  "@type": ["owl:Class"],
  "rdfs:label": "Person",
  "rdfs:subClassOf": ["foaf:Agent"]
}
```

- `@id` converted to `_id` for MongoDB
- `@type` always an array
- All keys compacted (no dots in field names)

### RDF Statements

Statements provide metadata about assertions (provenance, timestamps):

```json
{
  "_id": "bold:stmt-12345",
  "@type": ["rdf:Statement"],
  "rdf:subject": "myapp:person-1",
  "rdf:predicate": "foaf:name",
  "rdf:object": "Jane Doe",
  "bold:when": "2024-01-15T10:30:00Z",
  "bold:provenance": "myapp:import-batch-1"
}
```

## API

### Constructor

```typescript
new Ontologize(
  ontologyCollection: MongoCollection,
  contextCollection: MongoCollection,
  statementsCollection: MongoCollection,
  opts?: {
    collections?: Record<string, MongoCollection>;
    idResolvers?: Record<string, Array<{ match: string; collection: string }>>;
  }
)
```

### Static Methods

#### `Ontologize.initialize(ontologyCollection, contextCollection, statementsCollection, opts)`
Initialize the singleton instance.

#### `Ontologize.get()`
Get the singleton instance. Throws if not initialized.

#### `Ontologize.isTBoxResource(resource): boolean`
Check if a resource is a TBox resource (class, property, ontology).

#### `Ontologize.isStatementResource(resource): boolean`
Check if a resource is an RDF Statement.

### Instance Methods

#### `importContext(context): Promise<void>`
Merge a context object into the global @context.

#### `getContext(): Promise<object>`
Retrieve the global @context from the Context collection.

### OntologizeServer Methods (Server Only)

#### `importFromFile(filePath, opts?): Promise<ImportResult>`
Import a JSON-LD file into collections.

#### `importData(data, opts?): Promise<ImportResult>`
Import parsed JSON-LD data into collections.

**Options:**
- `ontologize: boolean` - Merge TBox resources into ontology collection
- `beforeSaveFn: (resource) => resource | null` - Filter/modify resources before save
- see JSDoc for other options

## TypeScript Support

The module includes comprehensive TypeScript declarations:

```typescript
import { Ontologize, OntologizeOptions, Resource } from "ontologize";
import { OntologizeServer, ImportOptions, ImportResult } from "ontologize/server";

const ontologize: Ontologize = new Ontologize(
  ontologyCollection,
  contextCollection,
  statementsCollection,
  options
);
```

## Related Modules

- **[bold-ld](../bold-ld)** - JSON-LD processing, compaction, and proxy objects
- **[hylar-reasoner](../hylar-reasoner)** - OWL reasoning server

## Development

```bash
# Run tests
npm test

# Run specific test file
npm test -- --grep "import"
```

This module is part of the BOLD stack and depends on `bold-ld` for JSON-LD processing.
