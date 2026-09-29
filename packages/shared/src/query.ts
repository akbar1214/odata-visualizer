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

/** A grouping property in a $apply/groupby transformation. */
export interface GroupByNode {
  property: string;
  alias?: string;
}

/** An aggregate in a $apply/groupby transformation. */
export interface AggregateNode {
  method: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Omitted for count, which aggregates rows. */
  property?: string;
  alias?: string;
}

/** Options for building an OData V4 query URL. */
export interface QueryOptions {
  entitySet: string;
  /**
   * Entity type used to resolve property types and expand targets when
   * `entitySet` is not an actual entity set (the UI previews `/Part?...` using
   * the type name). The URL still uses `entitySet`.
   */
  rootEntityName?: string;
  filters?: FilterClause[];
  filterLogic?: 'and' | 'or';
  select?: string[];
  expand?: ExpandNode[];
  groupBy?: GroupByNode[];
  aggregates?: AggregateNode[];
  orderBy?: string;
  top?: number;
  skip?: number;
  count?: boolean;
  search?: string;
  /** Optional base URL; when set an absolute URL is returned. */
  baseUrl?: string;
  /** When provided, filter literals are typed from the model. */
  metadata?: ODataMetadata;
  /** Receives non-fatal problems, e.g. properties that are not in the model. */
  onWarning?: (message: string) => void;
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

/** Shape checks for the ISO 8601 forms OData V4 uses. */
const DATE_PATTERNS: Record<string, RegExp> = {
  'Edm.Date': /^\d{4}-\d{2}-\d{2}$/,
  'Edm.DateTimeOffset': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  'Edm.DateTime': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/,
  'Edm.TimeOfDay': /^\d{2}:\d{2}:\d{2}(\.\d+)?$/,
  'Edm.Duration': /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
};

/** Reject values like 2024-13-45 or "yesterday" that a service would refuse. */
function isPlausibleDateTime(type: string, raw: string): boolean {
  const pattern = DATE_PATTERNS[type];
  if (!pattern) return true;
  if (!pattern.test(raw.trim())) return false;

  if (type === 'Edm.Duration') return true;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)
    ) {
      return false;
    }
  }

  const time = /T(\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (time) {
    const [, hours, minutes, seconds] = time;
    if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 60) return false;
  }
  return true;
}

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

  if (DATE_TYPES.has(type) || type in DATE_PATTERNS) {
    const value = raw.trim();
    if (!value) throw new Error(`Empty ${type} value`);
    if (!isPlausibleDateTime(type, value)) {
      throw new Error(`Invalid ${type} value: ${raw} (expected an ISO 8601 ${type} literal)`);
    }
    return value;
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

/** An OData simple identifier, e.g. `Name` or `_internal`. */
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A property path, e.g. `Name` or `Address/City`. */
const PROPERTY_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * One `/`-separated resource path segment. Dots are allowed because the
 * builder UI addresses an entity by its qualified type name
 * (`SampleService.Models.Part`), which is not a property path.
 */
const RESOURCE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Validate the single resource path segment the URL is built from (an entity
 * set name, or the entity type name the builder UI previews with).
 */
function assertResourceSegment(entitySet: string): string {
  if (!entitySet || entitySet.trim().length === 0) {
    throw new Error('entitySet is required');
  }
  if (entitySet.startsWith('/') || entitySet.endsWith('/')) {
    throw new Error(
      `Invalid entitySet: ${JSON.stringify(entitySet)}. Expected a resource path without leading or trailing "/".`,
    );
  }
  // A container-qualified path (Container/EntitySet) is legitimate, so each
  // segment is checked on its own rather than rejecting "/" outright.
  for (const segment of entitySet.split('/')) {
    if (!RESOURCE_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid entitySet: ${JSON.stringify(entitySet)}. ` +
          'Expected a resource path of OData identifiers, e.g. "Parts" or "Container/Parts".',
      );
    }
  }
  return entitySet;
}

function assertIdentifier(value: string, label: string): string {
  if (!SIMPLE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertPropertyPath(value: string, label: string): string {
  if (!PROPERTY_PATH.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNonNegativeInteger(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isSortDirection(token: string): boolean {
  const lowered = token.toLowerCase();
  return lowered === 'asc' || lowered === 'desc';
}

/**
 * Build `$orderby`, which may name more than one field. Anything after the
 * direction used to be dropped silently, so `name desc junk` quietly produced
 * `name desc`; extra tokens are now an error instead.
 */
function buildOrderBy(orderBy: string): string {
  const clauses = orderBy
    .split(',')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  if (clauses.length === 0) {
    throw new Error('Invalid $orderby: no sort field given');
  }

  return clauses
    .map((clause) => {
      const tokens = clause.split(/\s+/);
      if (tokens.length > 2) {
        throw new Error(`Invalid $orderby expression: ${JSON.stringify(clause)}`);
      }
      const [rawField, direction] = tokens;
      // A lone `asc`/`desc` is a direction with its field missing (e.g. the
      // caller sent " desc"), not a request to sort on a column named "desc".
      if (tokens.length === 1 && isSortDirection(rawField)) {
        throw new Error(`Invalid $orderby: missing sort field in ${JSON.stringify(clause)}`);
      }
      const field = assertPropertyPath(rawField, '$orderby field');
      if (direction && !isSortDirection(direction)) {
        throw new Error(`Invalid sort direction: ${direction}`);
      }
      return `${encodeQueryValue(field)}${direction ? ` ${direction.toLowerCase()}` : ''}`;
    })
    .join(',');
}

/** Split a comma-separated list, ignoring commas inside single-quoted values. */
function splitLiteralList(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (char === "'" && input[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      if (char === "'") inString = false;
      current += char;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Strip one layer of surrounding quotes and un-escape doubled quotes, so the
 * value round-trips back through `formatV4Literal`. A value that mixes quoted
 * and unquoted text cannot be a single literal and is rejected rather than
 * escaped into something that silently never matches.
 */
function unquoteLiteral(value: string, property: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.includes("'")) {
    throw new Error(
      `Invalid "in" list value for "${property}": ${JSON.stringify(value)}. ` +
        'Use a quoted string (Edm.String and enum values) or an unquoted literal.',
    );
  }
  return value;
}

/**
 * Build the parenthesised value list of an `in` comparison. The list used to be
 * spliced in verbatim, which both skipped literal typing and let a value such
 * as `1) or true or (1` inject extra filter logic.
 */
function buildInList(raw: string, edmType: string | undefined, property: string): string {
  const empty = () =>
    new Error(`The "in" operator on "${property}" requires a non-empty list of values.`);

  const trimmed = raw.trim();
  if (trimmed.length === 0) throw empty();

  let inner = trimmed;
  if (trimmed.startsWith('(')) {
    if (!trimmed.endsWith(')')) {
      throw new Error(`Unbalanced parentheses in "in" list for "${property}": ${trimmed}`);
    }
    inner = trimmed.slice(1, -1);
  }
  if (/[()]/.test(inner)) {
    throw new Error(`Unexpected parentheses in "in" list for "${property}": ${trimmed}`);
  }

  const elements = splitLiteralList(inner)
    .map((element) => element.trim())
    .filter((element) => element.length > 0);
  if (elements.length === 0) throw empty();

  return `(${elements
    .map((element) => formatV4Literal(unquoteLiteral(element, property), edmType))
    .join(',')})`;
}

/**
 * Validate every value in an `$expand` tree before any of it is emitted. This
 * runs once for the whole tree so nested segments are covered no matter which
 * branch of `buildExpand` produces them.
 */
function validateExpand(expands: ExpandNode[]): void {
  for (const item of expands) {
    assertIdentifier(item.navProperty, 'navigation property');
    for (const selected of item.select ?? []) {
      assertIdentifier(selected, '$select');
    }
    for (const clause of item.filters ?? []) {
      assertPropertyPath(clause.property, 'property');
    }
    if (item.orderBy && item.orderBy.trim().length > 0) {
      buildOrderBy(item.orderBy);
    }
    assertNonNegativeInteger(item.top, '$top');
    assertNonNegativeInteger(item.skip, '$skip');
    if (item.expand?.length) validateExpand(item.expand);
  }
}

/**
 * Build an OData V4 query URL (relative to the service root, or absolute
 * when baseUrl is given).
 */
export function buildQueryUrl(options: QueryOptions): string {
  const entitySet = assertResourceSegment(options.entitySet);

  if (
    options.search &&
    (options.filters?.length || options.top !== undefined || options.skip !== undefined)
  ) {
    throw new Error(
      'OData V4 does not allow $search together with $filter, $top, or $skip. Use $filter alone, or $search with $select/$orderby/$count.',
    );
  }

  const hasApply = Boolean(
    (options.groupBy && options.groupBy.length > 0) ||
    (options.aggregates && options.aggregates.length > 0),
  );

  if (hasApply && options.expand && options.expand.length > 0) {
    throw new Error('OData V4 does not allow $expand together with $apply.');
  }
  if (hasApply && options.search) {
    throw new Error('OData V4 does not allow $search together with $apply.');
  }

  const rootEntity = resolveRootEntity(options);
  const params: string[] = [];
  const warn = options.onWarning;
  const checkProperty = (property: string): void => {
    if (!warn || !rootEntity || !options.metadata) return;
    const entity = findEntityByName(options.metadata.entities, rootEntity);
    if (!entity) return;
    const known = getEffectiveProperties(entity, options.metadata.entities).some(
      (p) => p.name === property,
    );
    if (!known) {
      warn(`"${property}" is not a property of ${rootEntity}.`);
    }
  };

  for (const filter of options.filters ?? []) {
    assertPropertyPath(filter.property, 'property');
    checkProperty(filter.property);
  }

  for (const selected of options.select ?? []) {
    assertIdentifier(selected, '$select');
  }
  validateExpand(options.expand ?? []);

  if (hasApply) {
    // $apply must be the first system query option. Aliases are caller-supplied,
    // so the value goes through the same encoding as the other options.
    const apply = buildApply(options.groupBy, options.aggregates, rootEntity, options.metadata);
    params.push(`$apply=${encodeQueryValue(apply)}`);
  }

  for (const selected of options.select ?? []) {
    checkProperty(selected);
  }

  const filterStr = buildFilter(options.filters ?? [], options.filterLogic ?? 'and', (property) =>
    lookupPropertyType(rootEntity, property, options.metadata),
  );
  if (filterStr) params.push(`$filter=${encodeQueryValue(filterStr)}`);

  if (options.select && options.select.length > 0) {
    params.push(`$select=${options.select.map(encodeQueryValue).join(',')}`);
  }

  if (options.expand && options.expand.length > 0) {
    const expandStr = buildExpand(options.expand, rootEntity, options.metadata, warn, '');
    if (expandStr) params.push(`$expand=${encodeQueryValue(expandStr)}`);
  }

  if (options.orderBy && options.orderBy.trim().length > 0) {
    const orderBy = buildOrderBy(options.orderBy);
    for (const clause of options.orderBy.split(',')) {
      const field = clause.trim().split(/\s+/)[0];
      if (field) checkProperty(field);
    }
    params.push(`$orderby=${orderBy}`);
  }

  assertNonNegativeInteger(options.top, '$top');
  if (options.top !== undefined) {
    params.push(`$top=${options.top}`);
  }

  assertNonNegativeInteger(options.skip, '$skip');
  if (options.skip !== undefined) {
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

/**
 * Build the `$apply` transformation: `groupby((A),aggregate(...))`, or a bare
 * `aggregate(...)` when no grouping is requested.
 */
function buildApply(
  groupBy: GroupByNode[] | undefined,
  aggregates: AggregateNode[] | undefined,
  rootEntity: string | undefined,
  metadata: ODataMetadata | undefined,
): string {
  const typeOf: TypeLookup = (property) => lookupPropertyType(rootEntity, property, metadata);

  const groupParts = (groupBy ?? []).map((group) => {
    const type = typeOf(group.property);
    if (!type && metadata && rootEntity) {
      throw new Error(`"${group.property}" is not a property of ${rootEntity}.`);
    }
    const alias = group.alias ? ` as ${group.alias}` : '';
    return `${group.property}${alias}`;
  });

  const aggregateParts = (aggregates ?? []).map((aggregate) => {
    if (aggregate.method === 'count') {
      const alias = aggregate.alias ?? 'count';
      return `$count as ${alias}`;
    }

    const property = aggregate.property;
    if (!property) {
      throw new Error(`Aggregate "${aggregate.method}" requires a property.`);
    }

    const type = typeOf(property);
    if (!type && metadata && rootEntity) {
      throw new Error(`"${property}" is not a property of ${rootEntity}.`);
    }
    if ((aggregate.method === 'sum' || aggregate.method === 'avg') && !isNumericEdmType(type)) {
      throw new Error(
        `Cannot ${aggregate.method} "${property}": ${aggregate.method} requires a numeric property (got ${type ?? 'unknown type'}).`,
      );
    }

    const alias = aggregate.alias ?? `${aggregate.method}_${property}`;
    return `${aggregate.method}(${property}) as ${alias}`;
  });

  const aggregateClause = aggregateParts.length > 0 ? `aggregate(${aggregateParts.join(',')})` : '';

  if (groupParts.length === 0) {
    if (!aggregateClause) {
      throw new Error('$apply requires at least one groupBy property or aggregate.');
    }
    return aggregateClause;
  }

  return `groupby((${groupParts.join(',')})${aggregateClause ? `,${aggregateClause}` : ''})`;
}

function isNumericEdmType(type: string | undefined): boolean {
  return type !== undefined && NUMERIC_TYPES.has(type);
}

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
      return `${clause.property} in ${buildInList(clause.value, edmType, clause.property)}`;
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
  warn?: (message: string) => void,
  pathPrefix = '',
): string {
  if (expands.length === 0) return '';
  if (!metadata) {
    // Without metadata we can only emit bare paths / user-provided options.
    return expands
      .map((item) => {
        const nested = item.expand?.length
          ? buildExpand(item.expand, undefined, metadata, warn, `${pathPrefix}${item.navProperty}/`)
          : '';
        const parts: string[] = [];
        if (item.select?.length) parts.push(`$select=${item.select.join(',')}`);
        if (nested) parts.push(`$expand=${nested}`);
        if (item.orderBy) parts.push(`$orderby=${buildOrderBy(item.orderBy)}`);
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

      if (parentEntityName && !targetEntityName && warn) {
        const parent = findEntityByName(metadata.entities, parentEntityName);
        const known = parent
          ? getEffectiveNavigationProperties(parent, metadata.entities).some(
              (n) => n.name === item.navProperty,
            )
          : false;
        if (!known) {
          warn(
            `"${pathPrefix}${item.navProperty}" is not a navigation property of ${parentEntityName}.`,
          );
        }
      }

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
        const nested = buildExpand(
          item.expand,
          targetEntityName,
          metadata,
          warn,
          `${pathPrefix}${item.navProperty}/`,
        );
        if (nested) parts.push(`$expand=${nested}`);
      }

      if (item.orderBy) {
        parts.push(`$orderby=${buildOrderBy(item.orderBy)}`);
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

  // The caller may know the entity type even when the path is not a set name.
  if (options.rootEntityName) {
    const direct = findEntityByName(options.metadata.entities, options.rootEntityName);
    if (direct) return direct.qualifiedName ?? direct.name;
  }

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
