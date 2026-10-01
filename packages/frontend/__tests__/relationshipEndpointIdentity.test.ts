import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { findEntity, getTargetEntityName } from '../src/utils/queryResolver';

/**
 * V3 document with no roles on the navigation property, so the target end is
 * picked by comparing the relationship's source end with the source entity.
 * With the association ends stored as qualified identities that comparison
 * must resolve the ends first: comparing `'A.Widget' === 'Widget'` failed and
 * returned the *source* type, which pointed the pathfinder backwards.
 */
const v3Csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="3.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="A" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Part" Relationship="R1" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="AOnly" Type="Edm.String" />
      </EntityType>
      <Association Name="R1">
        <End Type="A.Widget" Role="Widget" Multiplicity="1" />
        <End Type="B.Part" Role="Part" Multiplicity="*" />
      </Association>
    </Schema>
    <Schema Namespace="B" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Part">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <Property Name="BOnly" Type="Edm.String" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('getTargetEntityName through qualified V3 association ends', () => {
  it('returns the target end even though the source comparison is qualified', async () => {
    const model = await parseCSDL(v3Csdl);
    const widget = findEntity('A.Widget', model.entities)!;

    const target = getTargetEntityName('Part', widget, model);

    // `A.Part` is declared first, so returning the bare short name or the
    // source end both fail here.
    expect(target).toBe('B.Part');
    expect(findEntity(target!, model.entities)?.properties.map((p) => p.name)).toContain('BOnly');
  });
});
