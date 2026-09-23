import type { ODataMetadata } from './types.js';
import {
  findEntityByName,
  findEntitySet,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
} from './resolve.js';

/** A single comparison in a $filter expression. */
export interface FilterClause {
  property: string;
  /** eq, ne, gt, ge, lt, le, contains, startswith, endswith, in */
  operator: string;
  /** Raw input value; formatted per the property's EDM type when known. */
  value: string;
}

/** Nested $expand segment. */
export interface ExpandNode {
  navProperty: string;
  select?: string[];
  filters?: FilterClause[];
  filterLogic?: 'and' | 'or';
  /** e.g. "Name asc" or just "Name" (defaults to asc) */
  orderBy?: string;
  top?: number;
  skip?: number;
  expand?: ExpandNode[];
}

/** Options for building an OData V4 query URL. */
export interface QueryOptions {
  entitySet: string;
  filters?: FilterClause[];
  filterLogic?: 'and' | 'or';
  select?: string[];
  expand?: ExpandNode[];
  orderBy?: string;
  top?: number;
  skip?: number;
  count?: boolean;
  search?: string;
  /** Optional base URL; when set an absolute URL is returned. */
  baseUrl?: string;
  /** When provided, filter literals are typed from the model. */
  metadata?: ODataMetadata;
}

const COMPARISON_OPERATORS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
const STRING_FUNCTION_OPERATORS = new Set(['contains', 'startswith', 'endswith']);
const ALLOWED_OPERATORS = new Set([...COMPARISON_OPERATORS, ...STRING_FUNCTION_OPERATORS, 'in']);

const NUMERIC_TYPES = new Set([
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Byte',
  'Edm.SByte',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Single',
]);
const DATE_TYPES = new Set(['Edm.Date', 'Edm.DateTimeOffset', 'Edm.DateTime']);

/**
 * Format a raw input value as an OData V4 literal for the given EDM type.
 * V4 removed V2/V3 prefixes (guid'…', datetime'…'); dates and guids are
 * bare, strings are single-quoted with '' escaping.
 */
export function formatV4Literal(value: string, edmType?: string): string {
  if (value === undefined || value === null) return 'null';
  const raw = String(value);
  const type = edmType ?? inferTypeFromValue(raw);

  if (raw === '') {
    if (type === 'Edm.String') return "''";
    throw new Error(`Empty value is not valid for type ${type}`);
  }

  if (raw.toLowerCase() === 'null' && type !== 'Edm.String') {
    return 'null';
  }

  if (type === 'Edm.Boolean') {
    const lowered = raw.toLowerCase();
    if (lowered !== 'true' && lowered !== 'false') {
      throw new Error(`Invalid boolean value: ${raw}`);
    }
    return lowered;
  }

  if (NUMERIC_TYPES.has(type)) {
    if (!isNumericLiteral(raw)) {
      throw new Error(`Invalid ${type} value: ${raw}`);
    }
    return raw;
  }

  if (DATE_TYPES.has(type)) {
    if (!raw.trim()) throw new Error(`Empty ${type} value`);
    return raw.trim();
  }

  if (type === 'Edm.Guid') {
    if (
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)
    ) {
      throw new Error(`Invalid Edm.Guid value: ${raw}`);
    }
    return raw;
  }

  if (type === 'Edm.Binary') {
    if (/^X'.*'$/.test(raw)) return raw;
    return `X'${raw.replace(/^0x/i, '')}'`;
  }

  if (!type.startsWith('Edm.')) {
    // Enum member or other named type: NS.EnumType'VALUE'
    return `${type}'${raw.replace(/'/g, "''")}'`;
  }

  return `'${raw.replace(/'/g, "''")}'`;
}

/**
 * Percent-encode only the characters that would corrupt a query string:
 * `%` (existing escape), `&` (new parameter), `#` (fragment), and `+`
 * (decoded as a space by many servers). Spaces, quotes, and `=` are legal in
 * an OData system query option and are left readable.
 */
function encodeQueryValue(value: string): string {
  return value.replace(/[%&#+]/g, (char) => {
    switch (char) {
      case '%':
        return '%25';
      case '&':
        return '%26';
      case '#':
        return '%23';
      default:
        return '%2B';
    }
  });
}

/**
 * Build an OData V4 query URL (relative to the service root, or absolute
 * when baseUrl is given).
 */
export function buildQueryUrl(options: QueryOptions): string {
  const { entitySet } = options;
  if (!entitySet) {
    throw new Error('entitySet is required');
  }

  if (
    options.search &&
    (options.filters?.length || options.top !== undefined || options.skip !== undefined)
  ) {
    throw new Error(
      'OData V4 does not allow $search together with $filter, $top, or $skip. Use $filter alone, or $search with $select/$orderby/$count.',
    );
  }

  const rootEntity = resolveRootEntity(options);
  const params: string[] = [];

  const filterStr = buildFilter(options.filters ?? [], options.filterLogic ?? 'and', (property) =>
    lookupPropertyType(rootEntity, property, options.metadata),
  );
  if (filterStr) params.push(`$filter=${encodeQueryValue(filterStr)}`);

  if (options.select && options.select.length > 0) {
    params.push(`$select=${options.select.map(encodeQueryValue).join(',')}`);
  }

  if (options.expand && options.expand.length > 0) {
    const expandStr = buildExpand(options.expand, rootEntity, options.metadata);
    if (expandStr) params.push(`$expand=${encodeQueryValue(expandStr)}`);
  }

  if (options.orderBy) {
    const orderBy = options.orderBy.trim();
    if (orderBy) {
      const [field, dir] = orderBy.split(/\s+/);
      if (dir && dir.toLowerCase() !== 'asc' && dir.toLowerCase() !== 'desc') {
        throw new Error(`Invalid sort direction: ${dir}`);
      }
      params.push(`$orderby=${encodeQueryValue(field)}${dir ? ` ${dir.toLowerCase()}` : ''}`);
    }
  }

  if (options.top !== undefined) {
    if (!Number.isInteger(options.top) || options.top < 0) {
      throw new Error(`Invalid $top: ${options.top}`);
    }
    params.push(`$top=${options.top}`);
  }

  if (options.skip !== undefined) {
    if (!Number.isInteger(options.skip) || options.skip < 0) {
      throw new Error(`Invalid $skip: ${options.skip}`);
    }
    params.push(`$skip=${options.skip}`);
  }

  if (options.count) {
    params.push('$count=true');
  }

  if (options.search) {
    params.push(`$search=${encodeQueryValue(options.search)}`);
  }

  const path = `/${entitySet}${params.length > 0 ? `?${params.join('&')}` : ''}`;
  if (options.baseUrl) {
    const base = options.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }
  return path;
}

type TypeLookup = (property: string) => string | undefined;

function buildFilter(
  filters: FilterClause[],
  logic: 'and' | 'or',
  resolveType: TypeLookup,
): string {
  if (filters.length === 0) return '';

  const parts = filters.map((clause) => {
    const operator = clause.operator.toLowerCase();
    if (!ALLOWED_OPERATORS.has(operator)) {
      throw new Error(`Unsupported filter operator: ${clause.operator}`);
    }
    const edmType = resolveType(clause.property);

    if (STRING_FUNCTION_OPERATORS.has(operator)) {
      const literal = formatV4Literal(clause.value, 'Edm.String');
      return `${operator}(${clause.property},${literal})`;
    }

    if (operator === 'in') {
      const inner = clause.value.trim();
      const list = inner.startsWith('(') ? inner : `(${inner})`;
      return `${clause.property} in ${list}`;
    }

    const literal = formatV4Literal(clause.value, edmType ?? inferTypeFromValue(clause.value));
    return `${clause.property} ${operator} ${literal}`;
  });

  return parts.join(` ${logic} `);
}

function buildExpand(
  expands: ExpandNode[],
  parentEntityName: string | undefined,
  metadata: ODataMetadata | undefined,
): string {
  if (expands.length === 0) return '';
  if (!metadata) {
    // Without metadata we can only emit bare paths / user-provided options.
    return expands
      .map((item) => {
        const nested = item.expand?.length ? buildExpand(item.expand, undefined, metadata) : '';
        const parts: string[] = [];
        if (item.select?.length) parts.push(`$select=${item.select.join(',')}`);
        if (nested) parts.push(`$expand=${nested}`);
        if (item.orderBy) parts.push(`$orderby=${item.orderBy}`);
        if (item.top !== undefined) parts.push(`$top=${item.top}`);
        if (item.skip !== undefined) parts.push(`$skip=${item.skip}`);
        if (item.filters?.length) {
          const filterStr = buildFilter(item.filters, item.filterLogic ?? 'and', () => undefined);
          if (filterStr) parts.push(`$filter=${filterStr}`);
        }
        return parts.length > 0 ? `${item.navProperty}(${parts.join(';')})` : item.navProperty;
      })
      .join(',');
  }

  return expands
    .map((item) => {
      const parts: string[] = [];
      const targetEntityName = resolveExpandTarget(parentEntityName, item.navProperty, metadata);

      if (item.select?.length) {
        parts.push(`$select=${item.select.join(',')}`);
      }

      if (item.filters?.length) {
        const filterStr = buildFilter(item.filters, item.filterLogic ?? 'and', (property) =>
          lookupPropertyType(targetEntityName, property, metadata),
        );
        if (filterStr) parts.push(`$filter=${filterStr}`);
      }

      if (item.expand?.length) {
        const nested = buildExpand(item.expand, targetEntityName, metadata);
        if (nested) parts.push(`$expand=${nested}`);
      }

      if (item.orderBy) {
        parts.push(`$orderby=${item.orderBy}`);
      }
      if (item.top !== undefined) {
        parts.push(`$top=${item.top}`);
      }
      if (item.skip !== undefined) {
        parts.push(`$skip=${item.skip}`);
      }

      return parts.length > 0 ? `${item.navProperty}(${parts.join(';')})` : item.navProperty;
    })
    .join(',');
}

function resolveRootEntity(options: QueryOptions): string | undefined {
  if (!options.metadata) return undefined;
  const set = findEntitySet(options.metadata, options.entitySet);
  if (!set) return undefined;
  return set.entityTypeQualified ?? set.entityType;
}

function resolveExpandTarget(
  parentEntityName: string | undefined,
  navProperty: string,
  metadata: ODataMetadata,
): string | undefined {
  if (!parentEntityName) return undefined;
  const parent = findEntityByName(metadata.entities, parentEntityName);
  if (!parent) return undefined;
  const nav = getEffectiveNavigationProperties(parent, metadata.entities).find(
    (n) => n.name === navProperty,
  );
  if (!nav) return undefined;
  return nav.targetTypeQualified ?? nav.targetType;
}

function lookupPropertyType(
  entityName: string | undefined,
  property: string,
  metadata: ODataMetadata | undefined,
): string | undefined {
  if (!metadata || !entityName) return undefined;
  const entity = findEntityByName(metadata.entities, entityName);
  if (!entity) return undefined;
  const prop = getEffectiveProperties(entity, metadata.entities).find((p) => p.name === property);
  if (!prop) return undefined;
  return unwrapTypeDefinition(prop.type, metadata);
}

/** Follow TypeDefinition aliases to the underlying EDM type (enums stay as-is). */
function unwrapTypeDefinition(type: string, metadata: ODataMetadata): string {
  let current = type;
  const seen = new Set<string>();
  while (!current.startsWith('Edm.') && !seen.has(current)) {
    seen.add(current);
    const typeDef = metadata.typeDefinitions.find(
      (t) => t.qualifiedName === current || t.name === current,
    );
    if (!typeDef) break;
    current = typeDef.underlyingType;
  }
  return current;
}

function inferTypeFromValue(value: string): string {
  const raw = value.trim();
  if (raw === 'true' || raw === 'false') return 'Edm.Boolean';
  if (isNumericLiteral(raw)) return 'Edm.Double';
  if (raw.toLowerCase() === 'null') return 'Edm.String';
  return 'Edm.String';
}

function isNumericLiteral(raw: string): boolean {
  return /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw.trim());
}
