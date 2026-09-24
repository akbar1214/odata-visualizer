import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { findPaths, getReachableEntities } from '../src/utils/graphState';
import { getTargetEntityName, findEntity } from '../src/utils/queryResolver';

/**
 * Mirrors a Windchill-shaped model: navigation properties point at
 * namespace-qualified types (PTC.PrincipalMgmt.User) while the UI selects
 * entities by their short name.
 */
const windchillLike = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="PTC.MG" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="IDPMilestone">
        <Key><PropertyRef Name="Oid" /></Key>
        <Property Name="Oid" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="User" Target="PTC.PrincipalMgmt.User" />
        <NavigationProperty Name="Team" Target="Collection(PTC.PrincipalMgmt.Team)" />
      </EntityType>
      <EntityType Name="Project">
        <Key><PropertyRef Name="Oid" /></Key>
        <Property Name="Oid" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Milestones" Target="Collection(PTC.MG.IDPMilestone)" />
      </EntityType>
    </Schema>
    <Schema Namespace="PTC.PrincipalMgmt" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="User">
        <Key><PropertyRef Name="Oid" /></Key>
        <Property Name="Oid" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Manager" Target="PTC.PrincipalMgmt.User" />
      </EntityType>
      <EntityType Name="Team">
        <Key><PropertyRef Name="Oid" /></Key>
        <Property Name="Oid" Type="Edm.String" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function model() {
  return parseCSDL(windchillLike);
}

describe('getTargetEntityName', () => {
  it('returns the short name the rest of the graph compares against', async () => {
    const metadata = await model();
    const milestone = findEntity('IDPMilestone', metadata.entities)!;
    const target = getTargetEntityName('User', milestone, metadata);

    expect(target).toBe('User');
    // It must still resolve to the same entity.
    expect(findEntity(target!, metadata.entities)?.qualifiedName).toBe('PTC.PrincipalMgmt.User');
  });
});

describe('findPaths with qualified navigation targets', () => {
  it('finds a one-hop path to a qualified target type', async () => {
    const metadata = await model();
    const paths = findPaths('IDPMilestone', 'User', metadata);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual([
      { fromEntity: 'IDPMilestone', navProperty: 'User', toEntity: 'User' },
    ]);
  });

  it('finds a two-hop path across namespaces', async () => {
    const metadata = await model();
    const paths = findPaths('Project', 'User', metadata);

    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0][0].navProperty).toBe('Milestones');
    expect(paths[0][paths[0].length - 1].toEntity).toBe('User');
  });
});

describe('getReachableEntities', () => {
  it('lists reachable entities by their short names', async () => {
    const metadata = await model();
    const reachable = getReachableEntities('IDPMilestone', metadata);
    const names = [...reachable.values()].flat().map((entry) => entry.entity.name);

    expect(names).toContain('User');
    expect(names).toContain('Team');
    // The PathFinder target dropdown filters entities by e.name.
    expect(metadata.entities.some((e) => names.includes(e.name))).toBe(true);
  });
});
