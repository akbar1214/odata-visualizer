import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/parser.js';

/**
 * `parseEdmxDocument` read each `<Reference>` position with `a || b`, so an
 * element carrying both the unprefixed and the `edmx:`-prefixed spelling lost
 * one group. XML allows both to coexist in the same parent.
 */
describe('mixed-prefix Reference siblings', () => {
  it('collects both spellings from the same parent', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Reference Uri="https://example.org/plain.xml" />
    <edmx:Reference Uri="https://example.org/prefixed.xml" />
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // Both were present; the `||` returned only the first.
    expect(model.unresolvedReferences?.sort()).toEqual([
      'https://example.org/plain.xml',
      'https://example.org/prefixed.xml',
    ]);
  });

  it('still collects a single unprefixed reference', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Reference Uri="https://example.org/only.xml" />
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.unresolvedReferences).toEqual(['https://example.org/only.xml']);
  });
});

/**
 * A V2 document names an association in `NavigationProperty/@Relationship`, and
 * a generator that aliases its namespace writes `Self.R1`. Nothing expanded it,
 * so the value stayed alias-qualified while every other type reference in the
 * same document was expanded — the metadata disagreed with itself.
 */
describe('NavigationProperty/@Relationship expansion', () => {
  it('expands an alias-qualified association name', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Children" Relationship="Self.R1" FromRole="W" ToRole="C" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    const nav = model.entities[0].navigationProperties[0];
    expect(nav.relationship).toBe('N.R1');
  });

  it('leaves an unqualified association name alone', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Children" Relationship="R1" FromRole="W" ToRole="C" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    expect(model.entities[0].navigationProperties[0].relationship).toBe('R1');
  });

  it('does not disturb the V4 collection marker', async () => {
    const model = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Children" Type="Collection(N.Widget)" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);

    // V4 stores 'Collection' here so multiplicity can be derived; expanding a
    // value with no dot must be a no-op.
    const nav = model.entities[0].navigationProperties[0];
    expect(nav.relationship).toBe('Collection');
    expect(model.relationships.length).toBeGreaterThan(0);
  });
});
