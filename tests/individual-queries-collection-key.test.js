/**
 * Copyright (c) 2026 2wav, Inc.
 *
 * This file is part of the BOLD libraries, licensed under the GNU Lesser
 * General Public License v3.0 or later. See LICENSE for details, or
 * <https://www.gnu.org/licenses/lgpl-3.0.html>.
 */

import { assert } from "chai";
import { Ontologize } from "../src/Ontologize.js";

/**
 * Regression test for the private per-visitor tour: individualQueries must
 * carry the *logical* registry key (the key under which the collection is
 * registered in this.collections), NOT the physical Mongo collection name.
 *
 * The client (ResourceList.vue) resolves a query's collection via
 * `ontologize.collections[query.collection]`, whose keys are logical
 * (ontology, context, statements, ex, abox, species, animal, orju). When the
 * physical Mongo name diverges from the logical key — as it does for private
 * tour collections named `species_<key>` — a query built from the physical
 * name (`species_<key>`) fails to resolve, so the individuals list is empty
 * even though the count is correct. For the shared singleton the two names
 * coincide, which is why this only surfaces in the tour.
 */

// Mock collection whose PHYSICAL name (collectionName) differs from the
// logical key it is registered under. Supports both the .find().toArray()
// path (used by _getInstanceInfoByType) and the .rawCollection().aggregate()
// path (used by _getInstanceCountsByType).
function makeMockCollection(physicalName, docs) {
  const countByType = (rows) => {
    const counts = {};
    for (const d of rows) {
      for (const t of (d["@type"] || [])) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    return Object.entries(counts).map(([_id, count]) => ({ _id, count }));
  };
  return {
    collectionName: physicalName,
    find() {
      return {
        toArray: async () => docs,
        fetch: () => docs
      };
    },
    findOne: async () => null,
    rawCollection() {
      return {
        aggregate(pipeline) {
          const hasMatch = pipeline.some(stage => stage.$match);
          return {
            toArray: async () => hasMatch ? [] : countByType(docs)
          };
        }
      };
    }
  };
}

function makeOntologizeWithSpecies(speciesCol) {
  const emptyCol = {
    findOne: async () => null,
    find: () => ({ toArray: async () => [], fetch: () => [] })
  };
  return new Ontologize(emptyCol, emptyCol, emptyCol, {
    collections: { species: speciesCol }
  });
}

describe("individualQueries collection key", function () {
  const speciesDocs = [
    { _id: "ex:sp1", "@type": ["ex:Species"] },
    { _id: "ex:sp2", "@type": ["ex:Species"] }
  ];

  it("_getInstanceCountsByType uses the logical key, not the physical Mongo name", async function () {
    const speciesCol = makeMockCollection("species_abc123", speciesDocs);
    const ont = makeOntologizeWithSpecies(speciesCol);

    const { individualQueries } = await ont.explore._getInstanceCountsByType([speciesCol]);

    assert.isArray(individualQueries["ex:Species"]);
    assert.equal(individualQueries["ex:Species"][0].collection, "species");
  });

  it("_getInstanceInfoByType uses the logical key, not the physical Mongo name", async function () {
    const speciesCol = makeMockCollection("species_abc123", speciesDocs);
    const ont = makeOntologizeWithSpecies(speciesCol);

    const { individualQueries } = await ont.explore._getInstanceInfoByType([speciesCol], {});

    assert.isArray(individualQueries["ex:Species"]);
    assert.equal(individualQueries["ex:Species"][0].collection, "species");
  });
});
