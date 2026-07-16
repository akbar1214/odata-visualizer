import type { ODataMetadata, ODataEntity, ODataProperty, ODataNavigationProperty } from '@odata-visualizer/shared';

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

export interface ExpandItem {
  navProperty: string;
  select: string[];
  expand: ExpandItem[];
  filters: QueryFilter[];
  sort: string;
  sortDirection: 'asc' | 'desc';
  top: number;
  skip: number;
}

export interface QueryState {
  entityName: string;
  filters: QueryFilter[];
  select: string[];
  expand: ExpandItem[];
  sort: string;
  sortDirection: 'asc' | 'desc';
  top: number;
  skip: number;
}

export function findEntity(entityName: string, entities: ODataEntity[]): ODataEntity | undefined {
  return entities.find(
    (e) => e.name.toLowerCase() === entityName.toLowerCase()
  );
}

export function resolveInheritance(entity: ODataEntity, entities: ODataEntity[]): ODataEntity[] {
  const chain: ODataEntity[] = [entity];
  if (entity.baseType) {
    const baseName = entity.baseType.includes('.')
      ? entity.baseType.split('.').pop() || entity.baseType
      : entity.baseType;
    const base = findEntity(baseName, entities);
    if (base && !chain.some((e) => e.name === base.name)) {
      chain.push(...resolveInheritance(base, entities));
    }
  }
  return chain;
}

export function getResolvedProperties(entity: ODataEntity, entities: ODataEntity[]): ODataProperty[] {
  const chain = resolveInheritance(entity, entities);
  const seen = new Set<string>();
  const props: ODataProperty[] = [];

  for (const e of chain.reverse()) {
    for (const prop of e.properties) {
      if (!seen.has(prop.name)) {
        seen.add(prop.name);
        props.push(prop);
      }
    }
  }

  return props;
}

export function getResolvedNavProperties(entity: ODataEntity, entities: ODataEntity[]): ODataNavigationProperty[] {
  const chain = resolveInheritance(entity, entities);
  const seen = new Set<string>();
  const navProps: ODataNavigationProperty[] = [];

  for (const e of chain.reverse()) {
    for (const nav of e.navigationProperties) {
      if (!seen.has(nav.name)) {
        seen.add(nav.name);
        navProps.push(nav);
      }
    }
  }

  return navProps;
}

export function getResolvedEntity(entityName: string, entities: ODataEntity[]): ResolvedEntity | undefined {
  const entity = findEntity(entityName, entities);
  if (!entity) return undefined;

  return {
    entity,
    allProperties: getResolvedProperties(entity, entities),
    allNavProperties: getResolvedNavProperties(entity, entities),
  };
}

export function getTargetEntityName(navProperty: string, sourceEntity: ODataEntity, metadata: ODataMetadata): string | undefined {
  // Search through resolved (inherited) nav properties
  const allNavProps = getResolvedNavProperties(sourceEntity, metadata.entities);
  const relationship = allNavProps.find((n) => n.name === navProperty);
  if (!relationship) return undefined;

  // OData V4: use targetType directly if no relationship defined
  if (relationship.targetType) {
    return relationship.targetType;
  }

  // OData V3: resolve through Association
  if (!relationship.relationship) return undefined;

  const rel = metadata.relationships.find((r) => r.name === relationship.relationship);
  if (!rel) return undefined;

  if (relationship.toRole) {
    if (rel.from.role === relationship.toRole) {
      return rel.from.entity;
    }
    return rel.to.entity;
  }

  if (rel.from.entity === sourceEntity.name) {
    return rel.to.entity;
  }
  return rel.from.entity;
}

const STRING_OPERATORS = ['eq', 'ne', 'contains', 'startswith', 'endswith'];
const NUMBER_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
const BOOLEAN_OPERATORS = ['eq'];
const DATE_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
const GUID_OPERATORS = ['eq', 'ne'];

export function getOperatorsForType(edmType: string): string[] {
  if (edmType === 'Edm.Boolean') return BOOLEAN_OPERATORS;
  if (
    edmType.startsWith('Edm.Int') ||
    edmType === 'Edm.Decimal' ||
    edmType === 'Edm.Double' ||
    edmType === 'Edm.Single' ||
    edmType === 'Edm.Byte' ||
    edmType === 'Edm.SByte'
  ) {
    return NUMBER_OPERATORS;
  }
  if (
    edmType === 'Edm.DateTime' ||
    edmType === 'Edm.DateTimeOffset' ||
    edmType === 'Edm.Date' ||
    edmType === 'Edm.Time' ||
    edmType === 'Edm.Duration'
  ) {
    return DATE_OPERATORS;
  }
  if (edmType === 'Edm.Guid') return GUID_OPERATORS;
  return STRING_OPERATORS;
}

export function getInputTypeForEdm(edmType: string): 'number' | 'date' | 'text' {
  if (
    edmType.startsWith('Edm.Int') ||
    edmType === 'Edm.Decimal' ||
    edmType === 'Edm.Double' ||
    edmType === 'Edm.Single' ||
    edmType === 'Edm.Byte' ||
    edmType === 'Edm.SByte'
  ) {
    return 'number';
  }
  if (
    edmType === 'Edm.DateTime' ||
    edmType === 'Edm.DateTimeOffset' ||
    edmType === 'Edm.Date'
  ) {
    return 'date';
  }
  return 'text';
}

export function formatODataValue(value: string, edmType: string): string {
  if (!value) return "''";

  if (edmType === 'Edm.Boolean') {
    return value.toLowerCase() === 'true' ? 'true' : 'false';
  }

  if (edmType.startsWith('Edm.Int') || edmType === 'Edm.Decimal' || edmType === 'Edm.Double' || edmType === 'Edm.Single') {
    return value;
  }

  if (edmType === 'Edm.Guid') {
    return `guid'${value}'`;
  }

  if (edmType === 'Edm.DateTime' || edmType === 'Edm.DateTimeOffset' || edmType === 'Edm.Date') {
    return `datetime'${value}'`;
  }

  return `'${value.replace(/'/g, "''")}'`;
}

function buildFilterString(filters: QueryFilter[], properties: ODataProperty[]): string {
  if (filters.length === 0) return '';

  const parts = filters.map((f) => {
    const prop = properties.find((p) => p.name === f.property);
    const edmType = prop?.type || 'Edm.String';
    const formattedValue = formatODataValue(f.value, edmType);

    if (f.operator === 'contains') return `contains(${f.property},${formattedValue})`;
    if (f.operator === 'startswith') return `startswith(${f.property},${formattedValue})`;
    if (f.operator === 'endswith') return `endswith(${f.property},${formattedValue})`;

    return `${f.property} ${f.operator} ${formattedValue}`;
  });

  return parts.join(' and ');
}

function buildExpandString(expands: ExpandItem[], metadata: ODataMetadata, parentEntityName: string): string {
  if (expands.length === 0) return '';

  return expands
    .map((item) => {
      const parts: string[] = [];

      if (item.select.length > 0) {
        parts.push(`$select=${item.select.join(',')}`);
      }

      if (item.filters.length > 0) {
        const targetEntity = getTargetEntityName(
          item.navProperty,
          findEntity(parentEntityName, metadata.entities)!,
          metadata
        );
        if (targetEntity) {
          const resolved = getResolvedEntity(targetEntity, metadata.entities);
          if (resolved) {
            const filterStr = buildFilterString(item.filters, resolved.allProperties);
            if (filterStr) parts.push(`$filter=${filterStr}`);
          }
        }
      }

      if (item.expand.length > 0) {
        const targetEntity = getTargetEntityName(
          item.navProperty,
          findEntity(parentEntityName, metadata.entities)!,
          metadata
        );
        if (targetEntity) {
          const subExpand = buildExpandString(item.expand, metadata, targetEntity);
          if (subExpand) parts.push(`$expand=${subExpand}`);
        }
      }

      if (item.sort) {
        parts.push(`$orderby=${item.sort} ${item.sortDirection}`);
      }

      if (item.top > 0) {
        parts.push(`$top=${item.top}`);
      }

      if (item.skip > 0) {
        parts.push(`$skip=${item.skip}`);
      }

      if (parts.length > 0) {
        return `${item.navProperty}(${parts.join(';')})`;
      }
      return item.navProperty;
    })
    .join(',');
}

export function buildODataQuery(
  query: QueryState,
  metadata: ODataMetadata
): string {
  const resolved = getResolvedEntity(query.entityName, metadata.entities);
  if (!resolved) return '';

  const parts: string[] = [];

  if (query.filters.length > 0) {
    const filterStr = buildFilterString(query.filters, resolved.allProperties);
    if (filterStr) parts.push(`$filter=${filterStr}`);
  }

  if (query.select.length > 0) {
    parts.push(`$select=${query.select.join(',')}`);
  }

  if (query.expand.length > 0) {
    const expandStr = buildExpandString(query.expand, metadata, query.entityName);
    if (expandStr) parts.push(`$expand=${expandStr}`);
  }

  if (query.sort) {
    parts.push(`$orderby=${query.sort} ${query.sortDirection}`);
  }

  if (query.top > 0) {
    parts.push(`$top=${query.top}`);
  }

  if (query.skip > 0) {
    parts.push(`$skip=${query.skip}`);
  }

  const queryString = parts.length > 0 ? `?${parts.join('&')}` : '';
  return `/${query.entityName}${queryString}`;
}

export function getDefaultQuery(entityName: string): QueryState {
  return {
    entityName,
    filters: [],
    select: [],
    expand: [],
    sort: '',
    sortDirection: 'asc',
    top: 25,
    skip: 0,
  };
}

export function isComplexType(entity: ODataEntity): boolean {
  return entity.keys.length === 0 && !entity.abstract;
}

export function getQueryableEntities(entities: ODataEntity[]): ODataEntity[] {
  return entities.filter((e) => !isComplexType(e));
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
