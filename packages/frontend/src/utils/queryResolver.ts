import type {
  ODataMetadata,
  ODataEntity,
  ODataEntitySet,
  ODataParameter,
  ODataProperty,
  ODataNavigationProperty,
} from '@odata-visualizer/shared';
import {
  assertResourceSegment,
  buildQueryOptions,
  buildQueryUrl,
  encodeIdentifierForUrl,
  findEntitiesByName,
  findEntityByName,
  formatV4Literal,
  getEffectiveKeys,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
  getAllEntitySets,
  getEntitySelectionValue,
  getTargetEntityName,
  resolveInheritanceChain,
  type ExpandNode,
} from '@odata-visualizer/shared';

// One implementation, in `shared`: the query graph stores these values in
// nodes and path steps, and MCP resolves the same names.
export { getEntitySelectionValue, getTargetEntityName };

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

/**
 * A bound-function resource-path segment. A function is not an expansion: the
 * query addresses the function result, and its options apply to that result.
 */
export interface FunctionSegment {
  /** Function simple name, for display. */
  name: string;
  /** Namespace-qualified name, as it appears in the URL. */
  qualifiedName: string;
  /** Parameters beyond the binding one; the builder only offers edges with none. */
  parameters: ODataParameter[];
  /** The binding parameter accepts a collection. */
  bindingIsCollection: boolean;
  /** The return type is a collection. */
  returnsCollection: boolean;
}

export interface QueryState {
  entityName: string;
  /**
   * When `segment` is set, the entity type the function is invoked on; the
   * resource path is built from its set, not from the result type's.
   */
  sourceEntity?: string;
  /** Bound-function segment forming the resource path; the query addresses its result. */
  segment?: FunctionSegment;
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
export function getResolvedEntity(
  entityName: string,
  entities: ODataEntity[],
): ResolvedEntity | undefined {
  const entity = findEntity(entityName, entities);
  if (!entity) return undefined;

  return {
    entity,
    allProperties: getResolvedProperties(entity, entities),
    allNavProperties: getEffectiveNavigationProperties(entity, entities),
  };
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
 * When the graph path starts with a bound function, the resource path is the
 * function *segment* (`/As('1')/N.B()`) and the query options apply to its
 * result — a function is never emitted into `$expand`.
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
 * `onWarning` is also handed to `buildQueryOptions`, which reports rows it can
 * format but cannot resolve (a property the model does not have). Those
 * messages are advisory: the row is *kept*. The UI's property and navigation
 * dropdowns are all model-derived, so no UI interaction produces that channel
 * today; it is wired for programmatic callers of this function.
 *
 * If the shared builder still throws (a state the pre-checks could not fix),
 * the catch reports why the preview fell back to the bare resource path — or to
 * no query at all when the resource path itself was refused — rather than
 * dropping every option silently.
 */
export function buildODataQuery(
  query: QueryState,
  metadata: ODataMetadata,
  onWarning?: QueryWarningHandler,
): string {
  const resolved = getResolvedEntity(query.entityName, metadata.entities);
  if (!resolved) return '';

  const filters = filterRows(query.filters, resolved.allProperties, '', onWarning);
  const expand =
    query.expand.length > 0
      ? filterExpandItems(query.expand, query.entityName, metadata, '', onWarning)
      : [];

  const options = {
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
  };

  // The resource path is also the fallback when the options cannot be built:
  // the preview keeps addressing the resource rather than collapsing.
  let path = '';
  try {
    if (query.segment) {
      path = functionSegmentPath(query, query.segment, metadata, onWarning);
      if (!path) return '';

      return `${path}${buildQueryOptions(options)}`;
    }

    const entitySet = resolveResourcePath(query.entityName, metadata);
    if (!entitySet) return '';
    // The catch below falls back to this path, and the set name comes from the
    // model. `assertResourceSegment` refuses a name that is not a resource path
    // (`Th#ings`), so the fallback would otherwise undo the refusal by
    // re-emitting it raw — a pasted `/Th#ings` truncates at the fragment and
    // lands on `/Th`. Each `/`-separated segment is encoded through the shared
    // encoder, the way every other metadata-derived identifier is emitted. The
    // fallback treats the name as data, so even for a name the assertion accepts
    // it is not always the identity: a key-predicate-shaped name is emitted raw
    // as structure by the happy path (`Parts('P1')?$top=25`) but encoded by the
    // fallback (`/Parts%28%27P1%27%29`). (A bound-function path is asserted
    // where it is built, so it is already safe to fall back to.)
    try {
      path = `/${entitySet
        .split('/')
        .map((segment) => encodeIdentifierForUrl(segment))
        .join('/')}`;
    } catch (error) {
      // `percentEncode` throws only for a name no URL can carry (an unpaired
      // surrogate), so there is no safe path to fall back to. Name the encoding
      // failure: the outer catch would claim it was showing the bare resource
      // path, and the caller's empty state would blame an unexposed set.
      const reason = error instanceof Error ? error.message : String(error);
      onWarning?.(
        `The resource path could not be encoded, so the preview shows no query: ${reason}`,
      );
      return '';
    }

    // `buildQueryUrl` rather than `buildQueryOptions`: it asserts the set path
    // first, so a set name that is not a resource path (`As?evil=1`) is
    // reported instead of being concatenated into a URL with its options.
    return buildQueryUrl({ ...options, entitySet });
  } catch (error) {
    // Invalid state while the user is editing: show the bare resource path
    // rather than an error state in the preview, but say so — silently losing
    // every other option is worse than the note. When the resource path itself
    // was refused (an invalid function segment), `path` is empty and "shows
    // only the resource path" would claim a preview that is not there.
    const reason = error instanceof Error ? error.message : String(error);
    onWarning?.(
      path
        ? `The full query could not be built, so the preview shows only the resource path: ${reason}`
        : `The full query could not be built, so the preview shows no query: ${reason}`,
    );
    return path;
  }
}

/**
 * The placeholder key the preview puts on a single-entity binding. The builder
 * has no key input, so it says what it did rather than emitting a URL that
 * silently addresses the whole collection.
 */
const PLACEHOLDER_KEY = "'1'";

/**
 * A placeholder literal for a key property, typed by the property's EDM type:
 * an `Edm.Int32` key yields `1`, a string key `'1'`. A type the placeholder
 * cannot represent (a guid, a date) falls back to the quoted form; the warning
 * asks the user to replace the placeholder either way.
 */
function placeholderKeyLiteral(type: string | undefined): string {
  if (!type) return PLACEHOLDER_KEY;
  try {
    return formatV4Literal('1', type);
  } catch {
    return PLACEHOLDER_KEY;
  }
}

function placeholderKeySegment(
  entityName: string,
  metadata: ODataMetadata,
  onWarning?: QueryWarningHandler,
): string {
  const entity = findEntityByName(metadata.entities, entityName);
  const keys = entity ? getEffectiveKeys(entity, metadata.entities) : [];
  const properties = entity ? getEffectiveProperties(entity, metadata.entities) : [];
  const literalFor = (keyName: string) =>
    placeholderKeyLiteral(properties.find((p) => p.name === keyName)?.type);

  if (keys.length === 0) {
    // A keyless type has no key to replace the placeholder with, so the
    // generic "replace it" note would be misleading: no valid single-entity
    // path exists, and the placeholder only sketches the shape.
    onWarning?.(
      `${entityName} declares no key, so no single-entity path can be built; the placeholder ${PLACEHOLDER_KEY} sketches the shape only.`,
    );
    return `(${PLACEHOLDER_KEY})`;
  }
  onWarning?.(
    `The preview uses key placeholder ${PLACEHOLDER_KEY} on ${entityName}; replace it with a real key.`,
  );
  if (keys.length === 1) return `(${literalFor(keys[0])})`;
  // A key name is a metadata-derived identifier in a path position, so it is
  // encoded through the shared policy the way MCP emits key names. Raw, a name
  // containing `)` or `=` would close the predicate and reshape it into
  // structure; `assertResourceSegment` is the wrong guard here because it
  // *accepts* a `/` as a path separator, which inside a key predicate addresses
  // a different resource.
  return `(${keys.map((key) => `${encodeIdentifierForUrl(key)}=${literalFor(key)}`).join(',')})`;
}

/**
 * Build the resource path of a bound-function step: the source set (with a key
 * when the function is bound to one entity) followed by the qualified function
 * segment. Returns `''` when the source has no resource path or the segment
 * cannot be composed.
 */
function functionSegmentPath(
  query: QueryState,
  segment: FunctionSegment,
  metadata: ODataMetadata,
  onWarning?: QueryWarningHandler,
): string {
  // The UI only offers parameterless functions, but a programmatic caller can
  // hand over an edge it could not compose: refuse rather than emit a call
  // that silently omits a required parameter.
  if (segment.parameters.length > 0) {
    onWarning?.(
      `The preview cannot call ${segment.qualifiedName}(): it requires parameter values, which this builder has no input for.`,
    );
    return '';
  }

  const source = query.sourceEntity ?? '';
  const sourcePath = source ? resolveResourcePath(source, metadata) : undefined;
  if (!sourcePath) return '';

  // Assert the path's structure before the placeholder note is emitted. The
  // assertion used to run after it, so a refused function name produced two
  // warnings: the placeholder note for a preview that was never built, then
  // the refusal. The note must only describe a path that survives.
  const assertedSourcePath = assertResourceSegment(sourcePath);
  const assertedFunctionName = assertResourceSegment(segment.qualifiedName);

  const key = segment.bindingIsCollection ? '' : placeholderKeySegment(source, metadata, onWarning);
  return `/${assertedSourcePath}${key}/${assertedFunctionName}()`;
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
