import type {
  ODataMetadata,
  ODataEntity,
  ODataAssociationEnd,
  ODataEntitySet,
  ODataProperty,
  ODataNavigationProperty,
} from '@odata-visualizer/shared';
import {
  buildQueryUrl,
  findEntitiesByName,
  findEntityByName,
  formatV4Literal,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
  getAllEntitySets,
  resolveInheritanceChain,
  type ExpandNode,
} from '@odata-visualizer/shared';

export interface ResolvedEntity {
  entity: ODataEntity;
  allProperties: ODataProperty[];
  allNavProperties: ODataNavigationProperty[];
}

export interface QueryFilter {
  property: string;
  operator: string;
  value: string;
}

export type FilterLogic = 'and' | 'or';

export interface ExpandItem {
  navProperty: string;
  select: string[];
  expand: ExpandItem[];
  filters: QueryFilter[];
  filterLogic: FilterLogic;
  sort: string;
  sortDirection: 'asc' | 'desc';
  top: number;
  skip: number;
}

export interface QueryState {
  entityName: string;
  filters: QueryFilter[];
  filterLogic: FilterLogic;
  select: string[];
  expand: ExpandItem[];
  sort: string;
  sortDirection: 'asc' | 'desc';
  top: number;
  skip: number;
}

/**
 * Receives a user-facing warning for the built query.
 *
 * `omittedFilter` is true when the message reports a filter row that is absent
 * from the query (the preview has to say what it silently dropped). It is
 * false/absent for advisory messages about rows that were kept, such as the
 * shared builder reporting a property the model does not have.
 */
export type QueryWarningHandler = (message: string, omittedFilter?: boolean) => void;

/** Find an entity by short or namespace-qualified name. */
export function findEntity(entityName: string, entities: ODataEntity[]): ODataEntity | undefined {
  return findEntityByName(entities, entityName);
}

/** Inheritance chain, most-derived first. */
export function resolveInheritance(entity: ODataEntity, entities: ODataEntity[]): ODataEntity[] {
  return resolveInheritanceChain(entity, entities);
}

/** Own + inherited properties, base types first. */
export function getResolvedProperties(
  entity: ODataEntity,
  entities: ODataEntity[],
): ODataProperty[] {
  return getEffectiveProperties(entity, entities);
}

/** Own + inherited navigation properties, base types first. */
export function getResolvedNavProperties(
  entity: ODataEntity,
  entities: ODataEntity[],
): ODataNavigationProperty[] {
  return getEffectiveNavigationProperties(entity, entities);
}

export function getResolvedEntity(
  entityName: string,
  entities: ODataEntity[],
): ResolvedEntity | undefined {
  const entity = findEntity(entityName, entities);
  if (!entity) return undefined;

  return {
    entity,
    allProperties: getResolvedProperties(entity, entities),
    allNavProperties: getResolvedNavProperties(entity, entities),
  };
}

/**
 * Resolve the entity type a navigation property points at.
 *
 * Returns the target's **graph identity**, not its short name: the short name
 * while it is unique in the model, and `Namespace.Name` when two types share
 * the short name (`getEntitySelectionValue`). The query graph stores these
 * values in nodes and path steps and compares them directly. Returning an
 * ambiguous short name made every consumer resolve it with first-match-wins,
 * so expanding a navigation property silently landed on whichever same-named
 * type was parsed first.
 *
 * The value is always resolvable through `findEntity`, which prefers an exact
 * qualified match over a short one. Ambiguity is judged the same way that
 * resolver matches — case-insensitively — so a case-only collision is qualified
 * too rather than resolving to the first of the pair.
 */
export function getTargetEntityName(
  navProperty: string,
  sourceEntity: ODataEntity,
  metadata: ODataMetadata,
): string | undefined {
  const nav = getResolvedNavProperties(sourceEntity, metadata.entities).find(
    (n) => n.name === navProperty,
  );
  if (!nav) return undefined;

  // OData V4: the navigation property points straight at the target type. The
  // qualified reference is preferred over the short one even when it cannot be
  // resolved: it names a type from an unloaded reference, and the short name
  // may silently name a different type in this model.
  if (nav.targetTypeQualified) {
    const target = findEntityByName(metadata.entities, nav.targetTypeQualified);
    if (target) return getEntitySelectionValue(target, metadata.entities);
    return nav.targetTypeQualified;
  }
  if (nav.targetType) return nav.targetType;

  // OData V3: resolve through the Association. The endpoint identity is
  // resolved before it is compared, so both the endpoint lookup and the source
  // comparison work on identities rather than short names.
  if (!nav.relationship) return undefined;
  // The association is stored under its *simple* name (`parseAssociation` keeps
  // `@_Name` verbatim), but a namespaced generator writes `Self.R1` — or `N.R1`
  // once the parser expands `Schema/@Alias`. Matching the two directly missed
  // every such document, so the whole V3 pathfinder branch was dead.
  //
  // A qualified reference names the association's *namespace*, and that is what
  // the qualifier is for: two namespaces may declare the same simple name.
  // Preferring the source entity's namespace instead picked the wrong
  // association whenever the two differed — which is the only case where a
  // generator writes the qualified form at all.
  const dot = nav.relationship.lastIndexOf('.');
  const qualifier = dot > 0 ? nav.relationship.slice(0, dot) : undefined;
  const localName = dot > 0 ? nav.relationship.slice(dot + 1) : nav.relationship;
  const sameName = metadata.relationships.filter(
    (r) => r.name === nav.relationship || r.name === localName,
  );

  // A qualifier that names a namespace in this model is authoritative: the
  // reference is explicitly qualified, so an association outside that namespace
  // is a dangling reference and stays unresolved. Guessing from the source
  // entity's namespace instead silently followed an unrelated association that
  // merely shared the simple name.
  const modelNamespaces = new Set<string>();
  for (const entity of metadata.entities) {
    if (entity.namespace) modelNamespaces.add(entity.namespace);
  }
  for (const relationship of metadata.relationships) {
    if (relationship.namespace) modelNamespaces.add(relationship.namespace);
  }
  const qualified = qualifier !== undefined && modelNamespaces.has(qualifier);

  const rel = qualified
    ? sameName.find((r) => r.namespace === qualifier)
    : // An unrecognised qualifier is most likely an alias this layer cannot
      // expand, so the source entity's own namespace is the better guess. There
      // is no separate exact-name clause: `sameName` already matches both
      // spellings, so it would only ever return an element of this list.
      (sameName.find((r) => r.namespace === sourceEntity.namespace) ?? sameName[0]);
  if (!rel) return undefined;

  const endIdentity = (end: ODataAssociationEnd): string => {
    const target = findEntityByName(metadata.entities, end.entityQualified ?? end.entity);
    return target
      ? getEntitySelectionValue(target, metadata.entities)
      : (end.entityQualified ?? end.entity);
  };

  if (nav.toRole) {
    // #35's both-ends check, wrapped so the result is an identity rather than
    // a stored endpoint. Taking either side wholesale breaks the other's tests:
    // #35's raw returns give qualified strings where callers expect identities,
    // and #38's one-liner loses the neither-end fallthrough.
    if (rel.from.role === nav.toRole) return endIdentity(rel.from);
    if (rel.to.role === nav.toRole) return endIdentity(rel.to);
  }
  return endIdentity(rel.from) === getEntitySelectionValue(sourceEntity, metadata.entities)
    ? endIdentity(rel.to)
    : endIdentity(rel.from);
}

const STRING_OPERATORS = ['eq', 'ne', 'contains', 'startswith', 'endswith'];
const NUMBER_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
const BOOLEAN_OPERATORS = ['eq'];
const DATE_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
const GUID_OPERATORS = ['eq', 'ne'];

const NUMERIC_EDM_TYPES = new Set([
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Single',
  'Edm.Byte',
  'Edm.SByte',
]);

const TEMPORAL_EDM_TYPES = new Set([
  'Edm.DateTime',
  'Edm.DateTimeOffset',
  'Edm.Date',
  'Edm.TimeOfDay',
  'Edm.Duration',
]);

export function getOperatorsForType(edmType: string): string[] {
  if (edmType === 'Edm.Boolean') return BOOLEAN_OPERATORS;
  if (edmType.startsWith('Edm.Int') || NUMERIC_EDM_TYPES.has(edmType)) {
    return NUMBER_OPERATORS;
  }
  if (TEMPORAL_EDM_TYPES.has(edmType)) return DATE_OPERATORS;
  if (edmType === 'Edm.Guid') return GUID_OPERATORS;
  return STRING_OPERATORS;
}

export function getInputTypeForEdm(edmType: string): 'number' | 'date' | 'text' {
  if (edmType.startsWith('Edm.Int') || NUMERIC_EDM_TYPES.has(edmType)) {
    return 'number';
  }
  if (edmType === 'Edm.DateTime' || edmType === 'Edm.DateTimeOffset' || edmType === 'Edm.Date') {
    return 'date';
  }
  return 'text';
}

/**
 * Format a value as an OData V4 literal. The shared formatter also validates
 * the value; while the user is still typing we fall back to a quoted string
 * so the preview never throws.
 */
export function formatODataValue(value: string, edmType: string): string {
  if (!value) return "''";
  try {
    return formatV4Literal(value, edmType);
  } catch {
    return `'${value.replace(/'/g, "''")}'`;
  }
}

function toExpandNode(item: ExpandItem): ExpandNode {
  return {
    navProperty: item.navProperty,
    select: item.select.length > 0 ? item.select : undefined,
    filters: item.filters.length > 0 ? item.filters : undefined,
    filterLogic: item.filterLogic,
    orderBy: item.sort ? `${item.sort} ${item.sortDirection}` : undefined,
    top: item.top > 0 ? item.top : undefined,
    skip: item.skip > 0 ? item.skip : undefined,
    expand: item.expand.length > 0 ? item.expand.map(toExpandNode) : undefined,
  };
}

/** The entity set that owns a given type, if one exists. */
function setForType(entity: ODataEntity, metadata: ODataMetadata): ODataEntitySet | undefined {
  const sets = getAllEntitySets(metadata);
  const typeRef = (set: ODataEntitySet) => set.entityTypeQualified ?? set.entityType;

  // An exact qualified reference is unambiguous even under a case collision:
  // `Shop.Order` and `SHOP.Order` are different types, and a set naming one of
  // them exactly binds to it. The conservative guard below rejects *both*, which
  // left a case-colliding type with no resource path at all — so the selector
  // emitted its qualified name and the builder answered "not exposed as an
  // entity set" for a type that plainly is.
  if (entity.qualifiedName) {
    const exact = sets.find((set) => set.entityTypeQualified === entity.qualifiedName);
    if (exact) return exact;
  }

  // A set whose type reference names exactly one type — this very entity.
  // An ambiguous short reference matches nothing, because a wrong match would
  // silently bind the type to another namespace's set. The repo's Windchill
  // fixture has two `Part` types, so this is the common case, not a corner one.
  const byTypeRef = sets.find((set) => {
    const matches = findEntitiesByName(metadata.entities, typeRef(set));
    return matches.length === 1 && matches[0] === entity;
  });
  if (byTypeRef) return byTypeRef;

  // The parser derives `entityType` as the short name of the raw reference, so
  // this recovers an alias-qualified reference (`self.Widget`) that the parser
  // does not expand. Guarded the same way, so it cannot capture across
  // namespaces either.
  return sets.find((set) => {
    if (set.entityType.toLowerCase() !== entity.name.toLowerCase()) return false;
    const matches = findEntitiesByName(metadata.entities, set.entityType);
    return matches.length === 1 && matches[0] === entity;
  });
}

/**
 * The identity the entity selector and the query graph use for a type.
 *
 * Short names are used while they are unique — that is what the graph and the
 * rest of the UI speak. When two types share a short name (the Windchill
 * fixture ships two `Part` types) the qualified name is used instead, because
 * otherwise both dropdown entries emit the same string and the selection
 * silently resolves to whichever one the parser saw first. That turned a loud
 * 404 into a query against the wrong collection.
 *
 * Always compute the ambiguity against the *whole* model. A filtered list can
 * hide the colliding type, and the short value then resolves to it.
 */
export function getEntitySelectionValue(entity: ODataEntity, entities: ODataEntity[]): string {
  // Case-insensitively, because `findEntity` matches that way: two types
  // differing only by case would both emit the same short value, and every
  // consumer would resolve it to whichever was parsed first.
  const ambiguous = entities.some(
    (other) => other !== entity && other.name.toLowerCase() === entity.name.toLowerCase(),
  );
  return ambiguous ? (entity.qualifiedName ?? entity.name) : entity.name;
}

/** The URL segment an entity type is addressed by, or `undefined` when it has no
 * addressable resource path at all.
 *
 * An OData resource path uses the **entity set** name from the entity
 * container, not the type name: the type `Shop.Order` is reached at `/Orders`.
 * Using the type name produced URLs that 404 against any service whose set name
 * differs from its type name, which is the common case (`Products`/`Product`).
 *
 * A derived type has no set of its own; V4 addresses it through the base type's
 * set with a cast (`/Products/ODataDemo.FeaturedProduct`), which is what the
 * repo's own demo model needs for `FeaturedProduct`, `Customer` and `Employee`.
 *
 * Returning `undefined` rather than a plausible-looking path is deliberate: a
 * path that cannot be resolved is worse than none, because the preview then
 * looks like a working query.
 */
export function resolveResourcePath(
  entityName: string,
  metadata: ODataMetadata,
): string | undefined {
  const entity = findEntityByName(metadata.entities, entityName);

  // A name that is not a type is not addressable. `buildODataQuery` resolves the
  // type first and returns before calling this, so a bare entity set name can
  // never arrive; accepting one here implied a builder capability that does not
  // exist (#18 item 4).
  if (!entity) return undefined;

  const ownSet = setForType(entity, metadata);
  if (ownSet) return ownSet.name;

  // Walk up the inheritance chain: the nearest base type with a set wins, and
  // the selected type is appended as a cast. V4 requires the *qualified* name
  // there (`/Products/ODataDemo.FeaturedProduct`), so an unqualified type has
  // no valid cast to emit.
  const cast = entity.qualifiedName;
  if (cast && cast.includes('.')) {
    for (const base of resolveInheritanceChain(entity, metadata.entities).slice(1)) {
      const baseSet = setForType(base, metadata);
      if (baseSet) return `${baseSet.name}/${cast}`;
    }
  }

  return undefined;
}

/**
 * The longest raw value echoed inside a warning. A 3000-character value in a
 * 288px panel measured `scrollWidth=24000` before this cap; the row is still
 * dropped, the note just does not repeat the whole paste.
 */
const MAX_WARNING_VALUE_LENGTH = 40;

/** Shorten a value for display, keeping enough to recognise what was typed. */
function truncateValue(value: string): string {
  return value.length > MAX_WARNING_VALUE_LENGTH
    ? `${value.slice(0, MAX_WARNING_VALUE_LENGTH)}…`
    : value;
}

/**
 * The formatter's reason, with the raw value shortened. `formatV4Literal`
 * embeds the value it rejected (`Invalid Edm.Int32 value: <value>…`), so the
 * reason is the other place a paste-sized value could reach the panel.
 */
function summarizeValueError(error: unknown, value: string): string {
  const reason = error instanceof Error ? error.message : String(error);
  const shortened = truncateValue(value);
  // `split/join` rather than `replace`: the value is data, not a replacement
  // pattern, and all of its occurrences are the same rejected literal.
  return shortened === value ? reason : reason.split(value).join(shortened);
}

/**
 * Rows whose value cannot be formatted as a literal for the resolved property
 * are left out (the preview must stay buildable while editing) and reported.
 * The message names the row by property path and operator — two rows on the
 * same property with different operators must not collapse into one note —
 * and the `pathPrefix` identifies which expand node owns the row.
 *
 * A row whose property is not in the resolved shape is kept: the shared
 * builder can still format it and may have a better diagnosis of its own.
 */
function filterRows(
  filters: QueryFilter[],
  properties: ODataProperty[],
  pathPrefix: string,
  onWarning?: QueryWarningHandler,
): QueryFilter[] {
  return filters.filter((filter) => {
    const value = filter.value.trim();
    if (!value) return false;
    const type = properties.find((p) => p.name === filter.property)?.type;
    if (!type) return true;
    try {
      formatV4Literal(value, type);
      return true;
    } catch (error) {
      const path = pathPrefix ? `${pathPrefix}/${filter.property}` : filter.property;
      onWarning?.(
        `Filter on "${path}" (${filter.operator}) was left out of the query: ${summarizeValueError(error, value)}`,
        true,
      );
      return false;
    }
  });
}

/**
 * Recursively pre-validate every expand node's filter rows.
 *
 * Without this, one bad child value reached `buildQueryUrl` unchecked, the
 * `buildFilter` throw escaped it, and the outer catch collapsed the whole
 * preview to the bare resource path — losing `$filter`, `$select`, `$orderby`,
 * `$top` and `$expand` with no warning. The target is resolved the same way
 * the graph resolved it (`getTargetEntityName`), so the types validated here
 * are the types the shared builder will use.
 */
function filterExpandItems(
  items: ExpandItem[],
  parentEntityName: string | undefined,
  metadata: ODataMetadata,
  pathPrefix: string,
  onWarning?: QueryWarningHandler,
): ExpandItem[] {
  return items.map((item) => {
    const path = pathPrefix ? `${pathPrefix}/${item.navProperty}` : item.navProperty;
    const parent = parentEntityName ? findEntity(parentEntityName, metadata.entities) : undefined;
    const targetName = parent ? getTargetEntityName(item.navProperty, parent, metadata) : undefined;
    const target = targetName ? getResolvedEntity(targetName, metadata.entities) : undefined;

    return {
      ...item,
      filters: filterRows(item.filters, target?.allProperties ?? [], path, onWarning),
      expand: filterExpandItems(item.expand, targetName, metadata, path, onWarning),
    };
  });
}

/**
 * Build the OData V4 query for the builder UI. The shared builder is used so
 * literals, encoding, and expansion syntax stay identical to the MCP server.
 *
 * The UI picks an entity *type*; `resolveResourcePath` turns it into the entity
 * *set* the URL has to use, while the type is still passed as `rootEntityName`
 * so property lookup and literal typing resolve against the selected shape
 * rather than the set's.
 *
 * Filter rows whose value cannot be formatted as a literal for their property
 * are left out instead of discarding the whole query, at every level: the root
 * `filters` and each expand node's `filters` recursively. Each left-out row
 * with a value is reported through `onWarning` (marked `omittedFilter`),
 * naming the property path, the operator and the formatter's reason, so a
 * *complete* but invalid value (`2147483648` on `Edm.Int32`, `1.5` on an
 * integer) cannot disappear from the preview without an explanation. An empty
 * row is left out silently: a freshly added row is not a problem to report.
 *
 * `onWarning` is also handed to `buildQueryUrl`, which reports rows it can
 * format but cannot resolve (a property the model does not have). Those
 * messages are advisory: the row is *kept*. The UI's property and navigation
 * dropdowns are all model-derived, so no UI interaction produces that channel
 * today; it is wired for programmatic callers of this function.
 *
 * If the shared builder still throws (a state the pre-checks could not fix),
 * the catch reports why the preview fell back to the bare resource path rather
 * than dropping every option silently.
 */
export function buildODataQuery(
  query: QueryState,
  metadata: ODataMetadata,
  onWarning?: QueryWarningHandler,
): string {
  const resolved = getResolvedEntity(query.entityName, metadata.entities);
  if (!resolved) return '';

  const resourcePath = resolveResourcePath(query.entityName, metadata);
  if (!resourcePath) return '';

  const filters = filterRows(query.filters, resolved.allProperties, '', onWarning);
  const expand =
    query.expand.length > 0
      ? filterExpandItems(query.expand, query.entityName, metadata, '', onWarning)
      : [];

  try {
    return buildQueryUrl({
      entitySet: resourcePath,
      rootEntityName: query.entityName,
      metadata,
      onWarning,
      filters: filters.length > 0 ? filters : undefined,
      filterLogic: query.filterLogic,
      select: query.select.length > 0 ? query.select : undefined,
      expand: expand.length > 0 ? expand.map(toExpandNode) : undefined,
      orderBy: query.sort ? `${query.sort} ${query.sortDirection}` : undefined,
      top: query.top > 0 ? query.top : undefined,
      skip: query.skip > 0 ? query.skip : undefined,
    });
  } catch (error) {
    // Invalid state while the user is editing: show the bare resource path
    // rather than an error state in the preview, but say so — silently losing
    // every other option is worse than the note. This must use the resolved
    // entity *set* — returning the type name here would reintroduce the very
    // bug this function exists to fix.
    const reason = error instanceof Error ? error.message : String(error);
    onWarning?.(
      `The full query could not be built, so the preview shows only the resource path: ${reason}`,
    );
    return `/${resourcePath}`;
  }
}

export function getDefaultQuery(entityName: string): QueryState {
  return {
    entityName,
    filters: [],
    filterLogic: 'and',
    select: [],
    expand: [],
    sort: '',
    sortDirection: 'asc',
    top: 25,
    skip: 0,
  };
}

export function isComplexType(entity: ODataEntity): boolean {
  return entity.kind === 'complex';
}

/**
 * Types that can be queried directly. Abstract entity types are not queryable
 * resources, and complex types have no entity set at all.
 */
export function getQueryableEntities(entities: ODataEntity[]): ODataEntity[] {
  return entities.filter((entity) => !isComplexType(entity) && !entity.abstract);
}

export function groupEntitiesByNamespace(entities: ODataEntity[]): Map<string, ODataEntity[]> {
  const grouped = new Map<string, ODataEntity[]>();
  for (const entity of entities) {
    const ns = entity.namespace || 'Default';
    if (!grouped.has(ns)) grouped.set(ns, []);
    grouped.get(ns)!.push(entity);
  }
  return grouped;
}
