import type {
  ODataMetadata,
  ODataEntity,
  ODataProperty,
  ODataNavigationProperty,
} from '@odata-visualizer/shared';
import {
  buildQueryUrl,
  findEntityByName,
  formatV4Literal,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
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
 * Returns the **short** name on purpose: the query graph identifies entities
 * by `entity.name` (node ids, selects, path steps), and the PathFinder
 * compares these values directly. Returning a namespace-qualified name here
 * silently breaks path finding, because a traversal step would no longer
 * equal the short name chosen in the UI.
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

  // OData V4: the navigation property points straight at the target type.
  if (nav.targetType) return nav.targetType;
  if (nav.targetTypeQualified) {
    const target = findEntityByName(metadata.entities, nav.targetTypeQualified);
    if (target) return target.name;
  }

  // OData V3: resolve through the Association.
  if (!nav.relationship) return undefined;
  const rel = metadata.relationships.find((r) => r.name === nav.relationship);
  if (!rel) return undefined;

  if (nav.toRole) {
    return rel.from.role === nav.toRole ? rel.from.entity : rel.to.entity;
  }
  return rel.from.entity === sourceEntity.name ? rel.to.entity : rel.from.entity;
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

/**
 * Build the OData V4 query for the builder UI. The shared builder is used so
 * literals, encoding, and expansion syntax stay identical to the MCP server.
 *
 * The UI addresses the resource by entity type name (`/Part?...`), so the root
 * type is passed explicitly for literal typing. Filter rows that are still
 * being typed (empty or not yet a valid literal for their property) are left
 * out instead of discarding the whole query.
 */
export function buildODataQuery(query: QueryState, metadata: ODataMetadata): string {
  const resolved = getResolvedEntity(query.entityName, metadata.entities);
  if (!resolved) return '';

  const filters = query.filters.filter((filter) => {
    const value = filter.value.trim();
    if (!value) return false;
    const type = resolved.allProperties.find((p) => p.name === filter.property)?.type;
    if (!type) return true;
    try {
      formatV4Literal(value, type);
      return true;
    } catch {
      return false;
    }
  });

  try {
    return buildQueryUrl({
      entitySet: query.entityName,
      rootEntityName: query.entityName,
      metadata,
      filters: filters.length > 0 ? filters : undefined,
      filterLogic: query.filterLogic,
      select: query.select.length > 0 ? query.select : undefined,
      expand: query.expand.length > 0 ? query.expand.map(toExpandNode) : undefined,
      orderBy: query.sort ? `${query.sort} ${query.sortDirection}` : undefined,
      top: query.top > 0 ? query.top : undefined,
      skip: query.skip > 0 ? query.skip : undefined,
    });
  } catch {
    // Invalid values while the user is editing: show the bare resource path
    // rather than an error state in the preview.
    return `/${query.entityName}`;
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
