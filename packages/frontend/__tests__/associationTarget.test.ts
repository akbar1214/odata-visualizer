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

/**
 * The corners of the resolution order. Each of these returned a *confident
 * wrong answer* rather than `undefined`, which is worse than not resolving:
 * they feed `$expand` validation and PathFinder traversal, so the user is
 * taken to the wrong entity type with no warning.
 */
describe('association resolution does not guess', () => {
  const schema = (ns: string, body: string, alias?: string) =>
    `<Schema Namespace="${ns}"${alias ? ` Alias="${alias}"` : ''} xmlns="http://docs.oasis-open.org/odata/ns/edm">${body}</Schema>`;

  const entity = (name: string, navs = '') => `
      <EntityType Name="${name}">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />${navs}
      </EntityType>`;

  const association = (ns: string, from: string, fromRole: string, to: string, toRole: string) => `
      <Association Name="R1">
        <End Type="${ns}.${from}" Role="${fromRole}" Multiplicity="1" />
        <End Type="${ns}.${to}" Role="${toRole}" Multiplicity="*" />
      </Association>`;

  const parse = (schemas: string) =>
    parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>${schemas}
  </edmx:DataServices>
</edmx:Edmx>`);

  it('leaves a dangling qualified reference unresolved instead of following a stranger', async () => {
    // `N3` is a real namespace in the model but declares no `R1`. `N1` declares
    // one and `Widget` lives in `N1`, so guessing by source namespace expanded
    // to `Gadget`.
    const metadata = await parse(
      schema('N3', entity('Other')) +
        schema(
          'N1',
          entity(
            'Widget',
            '\n        <NavigationProperty Name="Kids" Relationship="N3.R1" FromRole="Widget" ToRole="Gadget" />',
          ) +
            entity('Gadget') +
            association('N1', 'Widget', 'Widget', 'Gadget', 'Gadget'),
        ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBeUndefined();
  });

  it('falls back to the source namespace when the qualifier cannot be resolved', async () => {
    // `Ghost` is neither a namespace in the model nor an alias the parser can
    // expand, so the qualifier carries no information. `N2`'s `R1` is declared
    // first; the source entity is in `N1`, whose association the roles name.
    const metadata = await parse(
      schema(
        'N2',
        entity('Widget2') +
          entity('Gadget2') +
          association('N2', 'Widget2', 'Widget2', 'Gadget2', 'Gadget2'),
      ) +
        schema(
          'N1',
          entity(
            'Widget',
            '\n        <NavigationProperty Name="Kids" Relationship="Ghost.R1" FromRole="Alpha" ToRole="Beta" />',
          ) +
            entity('Alpha') +
            entity('Beta') +
            association('N1', 'Alpha', 'Alpha', 'Beta', 'Beta'),
        ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Beta');
  });

  it('handles a dotted namespace in the qualifier', async () => {
    // Splitting on the *first* dot would leave `example.M.R1` as the local name
    // and fail to match anything.
    const metadata = await parse(
      schema(
        'com.example.M',
        entity(
          'Widget',
          '\n        <NavigationProperty Name="Kids" Relationship="com.example.M.R1" FromRole="Alpha" ToRole="Beta" />',
        ) +
          entity('Alpha') +
          entity('Beta') +
          association('com.example.M', 'Alpha', 'Alpha', 'Beta', 'Beta'),
      ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Beta');
  });

  it('does not return the source entity when no end carries the requested role', async () => {
    // Ends declared target-first, so the old logic fell through to `rel.to` —
    // the source entity itself.
    const metadata = await parse(
      schema(
        'N',
        entity(
          'Widget',
          '\n        <NavigationProperty Name="Kids" Relationship="R1" FromRole="Widget" ToRole="Bogus" />',
        ) +
          entity('Gadget') +
          association('N', 'Gadget', 'Gadget', 'Widget', 'Widget'),
      ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Gadget');
  });

  it('leaves a qualified reference to an unloaded namespace unresolved', async () => {
    // #39. `Ext` is an `Include` alias for `doc2.xml`, which never loads, so the
    // parser expands `Ext.R1` to `N2.R1` while N2's elements never arrive. N1's
    // own `R1` merely shares the simple name and its roles (Widget/Gadget) match
    // neither of the navigation property's (Alpha/Beta).
    const metadata = await parseCSDL(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="N1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <edmx:Reference Uri="https://example.org/doc2.xml">
        <edmx:Include Namespace="N2" Alias="Ext" />
      </edmx:Reference>
      <EntityType Name="Widget">
        <Key><PropertyRef Name="Id" /></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" />
        <NavigationProperty Name="Kids" Relationship="Ext.R1" FromRole="Alpha" ToRole="Beta" />
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
  </edmx:DataServices>
</edmx:Edmx>`);
    const widget = findEntity('Widget', metadata.entities)!;

    expect(metadata.unresolvedReferences).toContain('https://example.org/doc2.xml');
    expect(getTargetEntityName('Kids', widget, metadata)).toBeUndefined();
  });

  it('resolves through a same-named association whose roles agree', async () => {
    // `Ghost` is neither a namespace in the model nor an alias the parser can
    // expand, and the source entity's namespace declares no `R1` at all, so the
    // only candidate is N2's. Its roles match the navigation property's, which
    // is what makes following it corroboration rather than a guess.
    const metadata = await parse(
      schema(
        'N2',
        entity('Alpha') + entity('Beta') + association('N2', 'Alpha', 'Alpha', 'Beta', 'Beta'),
      ) +
        schema(
          'N1',
          entity(
            'Widget',
            '\n        <NavigationProperty Name="Kids" Relationship="Ghost.R1" FromRole="Alpha" ToRole="Beta" />',
          ),
        ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Beta');
  });

  it('returns the end the ToRole names even when it is the source type', async () => {
    // Ends declared target-first and `ToRole="Target"` names the *from* end,
    // whose type is the source's own. Without the from-role check the identity
    // fallthrough reads that end as the source and returns the other one.
    const metadata = await parse(
      schema(
        'N',
        entity(
          'Widget',
          '\n        <NavigationProperty Name="Buddy" Relationship="R1" FromRole="Other" ToRole="Target" />',
        ) +
          entity('Gadget') +
          `
      <Association Name="R1">
        <End Type="N.Widget" Role="Target" Multiplicity="1" />
        <End Type="N.Gadget" Role="Other" Multiplicity="*" />
      </Association>`,
      ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Buddy', widget, metadata)).toBe('Widget');
  });

  it('honours a qualifier declared only by an Association schema', async () => {
    // N2 declares no entity types, so the qualifier is only a model namespace
    // because relationships count too. Dropping them treats `N2.R1` as unknown
    // and follows N1's `R1`, which points at `Frob`.
    const metadata = await parse(
      schema(
        'N1',
        entity(
          'Widget',
          '\n        <NavigationProperty Name="Kids" Relationship="N2.R1" FromRole="Widget" ToRole="Gadget" />',
        ) +
          entity('Gadget') +
          entity('Frob') +
          association('N1', 'Widget', 'Widget', 'Frob', 'Frob'),
      ) +
        schema(
          'N2',
          `
      <Association Name="R1">
        <End Type="N1.Widget" Role="Widget" Multiplicity="1" />
        <End Type="N1.Gadget" Role="Gadget" Multiplicity="*" />
      </Association>`,
        ),
    );
    const widget = findEntity('Widget', metadata.entities)!;

    expect(getTargetEntityName('Kids', widget, metadata)).toBe('Gadget');
  });
});
