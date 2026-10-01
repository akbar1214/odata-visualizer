import { describe, it, expect } from 'vitest';
import { parseCSDL } from '@odata-visualizer/shared';
import { getTargetEntityName, findEntity } from '../src/utils/queryResolver';

/**
 * V2 document. The association is named `R1` (a simple name — `parseAssociation`
 * stores `@_Name` verbatim), but the navigation property may reference it as
 * `Self.R1` or `N.R1` once the parser expands `Schema/@Alias`.
 *
 * `getTargetEntityName` compared the two directly, so the V3 branch of the
 * pathfinder never resolved and `$expand` targets were unreachable for any
 * generator that namespaces its association references.
 */
const v2Csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="Self.R1" FromRole="Widget" ToRole="Gadget" />
      </EntityType>
      <EntityType Name="Gadget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="N.Widget" Role="Widget" Multiplicity="1" />
        <End Type="N.Gadget" Role="Gadget" Multiplicity="*" />
      </Association>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('getTargetEntityName through a V3 association', () => {
  it('resolves an association named with a namespace prefix', async () => {
    const metadata = await parseCSDL(v2Csdl);
    const widget = findEntity('Widget', metadata.entities)!;

    // `Self.R1` (raw) or `N.R1` (expanded) must both reach the `R1` association.
    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Gadget');
  });

  it('resolves an unqualified association name too', async () => {
    const metadata = await parseCSDL(v2Csdl.replace('Relationship="Self.R1"', 'Relationship="R1"'));
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Gadget');
  });

  it('still returns undefined for a navigation property that is not there', async () => {
    const metadata = await parseCSDL(v2Csdl);
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Nope', widget, metadata)).toBeUndefined();
  });
});

/**
 * A qualified `Relationship` names the association's *namespace*, which is the
 * whole reason a generator writes it: two namespaces may declare the same
 * simple name. Preferring the source entity's own namespace instead picked the
 * wrong association whenever the two differed.
 */
describe('a qualified association reference names its namespace', () => {
  const twoNamespaces = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="N2.R1" FromRole="Alpha" ToRole="Beta" />
      </EntityType>
      <EntityType Name="Gadget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="N1.Widget" Role="Widget" Multiplicity="1" />
        <End Type="N1.Gadget" Role="Gadget" Multiplicity="*" />
      </Association>
    </Schema>
    <Schema Namespace="N2" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Alpha">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <EntityType Name="Beta">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
      </EntityType>
      <Association Name="R1">
        <End Type="N2.Alpha" Role="Alpha" Multiplicity="1" />
        <End Type="N2.Beta" Role="Beta" Multiplicity="*" />
      </Association>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('follows the namespace the reference names, not the source entity’s', async () => {
    const metadata = await parseCSDL(twoNamespaces);
    const widget = findEntity('Widget', metadata.entities)!;

    // `Kids` names `N2.R1` and carries N2's roles, so `Beta` is the target.
    // N1 also declares an `R1`, and `Widget` lives in N1.
    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Beta');
  });
});
