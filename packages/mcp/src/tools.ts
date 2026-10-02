import type {
  ODataAction,
  ODataAssociationEnd,
  ODataEntity,
  ODataEntitySet,
  ODataFunction,
  ODataMetadata,
  ODataParameter,
  ODataProperty,
  ODataRelationship,
  ODataTypeDefinition,
} from '@odata-visualizer/shared';
import {
  buildQueryOptions,
  buildQueryUrl,
  encodeIdentifierForUrl,
  encodeLiteralForUrl,
  findEntitiesByName,
  findEntityByName,
  findEntitySet,
  findTypeInScope,
  formatV4Literal,
  getAllEntitySets,
  getEffectiveKeys,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
  getTraversalEdges,
  INTEGER_TYPES,
  isFunctionEdge,
  normalizeBaseUrl,
  resolveInheritanceChain,
  resourcePathOf,
  suggestNames,
  unwrapCollection,
  type ExpandNode,
  type FilterClause,
  type QueryOptions,
  type TraversalFunctionEdge,
} from '@odata-visualizer/shared';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadMetadataFromSource, type MetadataSource } from './metadata-loader.js';
import { createMetadataStore, type MetadataAccessors } from './store.js';

const defaultStore = createMetadataStore();

export function getMetadata(): ODataMetadata | null {
  return defaultStore.get()?.metadata ?? null;
}

export function resetMetadata(): void {
  defaultStore.clear();
}

export type ToolResult = CallToolResult;

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolHandlerOptions {
  /** When false, the load_metadata tool is rejected (e.g. the HTTP server). */
  allowLoadMetadata?: boolean;
  /**
   * When true (the default), an Edm.Int64/Edm.Decimal action body value that a
   * bare JSON number cannot carry verbatim is emitted as a JSON string and the
   * body declares `application/json;IEEE754Compatible=true`, which OData
   * services read back exactly. When false, the plain `application/json`
   * content type cannot carry it, so the value is refused instead.
   */
  ieee754Compatible?: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function paginate<T>(items: T[], args: Record<string, unknown>): { slice: T[]; note: string } {
  const limit = Math.min(MAX_LIMIT, Math.max(0, asNumber(args['limit']) ?? DEFAULT_LIMIT));
  const offset = Math.max(0, asNumber(args['offset']) ?? 0);
  const slice = items.slice(offset, offset + limit);

  if (slice.length === 0) {
    return { slice, note: `\n\nNo results at offset ${offset} (${items.length} total).` };
  }

  const from = offset + 1;
  const to = offset + slice.length;
  const note =
    items.length > to
      ? `\n\nShowing ${from}-${to} of ${items.length}. Use limit/offset for more.`
      : `\n\nShowing ${from}-${to} of ${items.length}.`;
  return { slice, note };
}

function formatEntitySummary(entity: ODataEntity, metadata: ODataMetadata): string {
  const keys = getEffectiveKeys(entity, metadata.entities);
  const keyStr = keys.length > 0 ? ` (keys: ${keys.join(', ')})` : '';
  const kind = entity.kind === 'complex' ? ' [complex]' : '';
  const abstract = entity.abstract ? ' [abstract]' : '';
  const base = entity.baseType ? ` : ${entity.baseType}` : '';
  const propCount = getEffectiveProperties(entity, metadata.entities).length;
  const navCount = getEffectiveNavigationProperties(entity, metadata.entities).length;
  const inherited =
    propCount !== entity.properties.length || navCount !== entity.navigationProperties.length
      ? ' (incl. inherited)'
      : '';
  return `${entity.qualifiedName ?? entity.name}${kind}${abstract}${base}${keyStr} - ${propCount} props, ${navCount} navs${inherited}`;
}

function formatRelationship(rel: ODataRelationship): string {
  return `${rel.name}: ${rel.from.entity} (${rel.from.multiplicity}) <-> ${rel.to.entity} (${rel.to.multiplicity})`;
}

/**
 * Render one bound-function edge for `get_relationships`.
 *
 * The binding cardinality and the non-binding parameters are both part of the
 * discovery answer: the first decides whether the composed path needs a key,
 * the second decides whether the caller must supply values before the edge can
 * be used at all.
 */
function formatOperationEdge(edge: TraversalFunctionEdge, metadata: ODataMetadata): string {
  const qualified = (identity: string): string => {
    const entity = findEntityByName(metadata.entities, identity);
    return entity?.qualifiedName ?? entity?.name ?? identity;
  };
  const target = edge.returnsCollection ? `Collection(${qualified(edge.to)})` : qualified(edge.to);
  const binding = edge.bindingIsCollection ? 'bound to the collection' : 'bound to one entity';
  const requirements =
    edge.parameters.length > 0
      ? `requires: ${edge.parameters.map((p) => `${p.name}: ${p.type}`).join(', ')}`
      : 'composable without parameters';
  return `${edge.qualifiedName}(): ${qualified(edge.from)} -> ${target} [${requirements}; ${binding}]`;
}

/**
 * Scan a type's effective properties (including inherited ones) without
 * allocating the merged list, so searching a large model stays cheap.
 */
function hasEffectiveProperty(
  entity: ODataEntity,
  entities: ODataEntity[],
  predicate: (lowerName: string) => boolean,
): boolean {
  const seen = new Set<string>();
  for (const type of resolveInheritanceChain(entity, entities)) {
    for (const prop of type.properties) {
      if (seen.has(prop.name)) continue;
      seen.add(prop.name);
      if (predicate(prop.name.toLowerCase())) return true;
    }
  }
  return false;
}

function hasEffectiveNavigation(
  entity: ODataEntity,
  entities: ODataEntity[],
  predicate: (lowerName: string) => boolean,
): boolean {
  const seen = new Set<string>();
  for (const type of resolveInheritanceChain(entity, entities)) {
    for (const nav of type.navigationProperties) {
      if (seen.has(nav.name)) continue;
      seen.add(nav.name);
      if (predicate(nav.name.toLowerCase())) return true;
    }
  }
  return false;
}

function resolveEntityArg(
  metadata: ODataMetadata,
  name: string,
): { entity: ODataEntity } | { error: ToolResult } {
  const matches = findEntitiesByName(metadata.entities, name);
  if (matches.length === 0) {
    const suggestions = suggestNames(
      name,
      metadata.entities.map((e) => e.qualifiedName ?? e.name),
    );
    const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    return { error: errorResult(`No entity matching "${name}".${hint}`) };
  }
  if (matches.length === 1) return { entity: matches[0] };

  // Exact case first, then the lowercased comparison. `findEntityByName` in
  // `shared` applies the same policy; this call site disambiguates for itself,
  // so it has to apply it too — otherwise `SHOP.Order` answered with
  // `Shop.Order`'s shape whenever both schemas declared the type.
  // Same key as the comparison below, just exact-case first. Note it is
  // `qualifiedName ?? name`, not `name`: a bare short name must still report
  // ambiguity rather than resolving to the first type that happens to share it.
  const exact = matches.find((e) => (e.qualifiedName ?? e.name) === name);
  if (exact) return { entity: exact };

  const caseInsensitive = matches.find(
    (e) => (e.qualifiedName ?? e.name).toLowerCase() === name.toLowerCase(),
  );
  if (caseInsensitive) return { entity: caseInsensitive };

  return {
    error: errorResult(
      `"${name}" is ambiguous. Use a qualified name: ${matches
        .map((e) => e.qualifiedName ?? e.name)
        .join(', ')}`,
    ),
  };
}

/**
 * Filter items whose endpoint names answer to `name`.
 *
 * The project-wide case policy (#40): an exact-case match wins and a lowercased
 * comparison is only the fallback. Two schemas differing only in case both
 * answered to either spelling while both sides were lowercased, so neither
 * namespace's relationships could be asked for precisely (#41).
 */
function matchNames<T>(items: T[], name: string, namesFor: (item: T) => string[]): T[] {
  const exact = items.filter((item) => namesFor(item).includes(name));
  if (exact.length > 0) return exact;
  const needle = name.toLowerCase();
  return items.filter((item) => namesFor(item).some((n) => n.toLowerCase() === needle));
}

function describeType(type: string, metadata: ODataMetadata): string {
  if (type.startsWith('Edm.')) return type;

  const collection = unwrapCollection(type);
  if (collection?.isCollection) {
    return `Collection(${describeType(collection.type, metadata)})`;
  }

  const enumType = metadata.enumTypes.find((e) => e.qualifiedName === type || e.name === type);
  if (enumType) {
    return `${type} (enum: ${enumType.members.map((m) => m.name).join(' | ')})`;
  }
  const typeDef = metadata.typeDefinitions.find((t) => t.qualifiedName === type || t.name === type);
  if (typeDef) return `${type} (type definition of ${typeDef.underlyingType})`;
  return type;
}

function formatEntityDetails(entity: ODataEntity, metadata: ODataMetadata): string {
  const lines: string[] = [];
  lines.push(`Entity: ${entity.qualifiedName ?? entity.name}`);
  lines.push(`Kind: ${entity.kind === 'complex' ? 'complex type' : 'entity type'}`);
  if (entity.label) lines.push(`Label: ${entity.label}`);
  if (entity.baseType) {
    const chain = resolveInheritanceChain(entity, metadata.entities);
    lines.push(`Inheritance: ${chain.map((e) => e.name).join(' -> ')}`);
  }
  if (entity.abstract) lines.push('Abstract: true');
  if (entity.openType) lines.push('Open Type: true');

  const keys = getEffectiveKeys(entity, metadata.entities);
  if (keys.length > 0) lines.push(`Keys: ${keys.join(', ')}`);

  if (entity.annotations && Object.keys(entity.annotations).length > 0) {
    lines.push('Annotations:');
    for (const [term, value] of Object.entries(entity.annotations)) {
      lines.push(`  - ${term}${value ? `: ${value}` : ''}`);
    }
  }

  const properties = getEffectiveProperties(entity, metadata.entities);
  if (properties.length > 0) {
    lines.push('\nProperties:');
    for (const prop of properties) {
      const flags: string[] = [];
      if (prop.isKey) flags.push('KEY');
      if (!prop.nullable) flags.push('non-nullable');
      if (prop.maxLength !== undefined) flags.push(`max: ${prop.maxLength}`);
      const inherited =
        prop.sourceType && prop.sourceType !== entity.name ? ` (from ${prop.sourceType})` : '';
      const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      lines.push(`  - ${prop.name}: ${describeType(prop.type, metadata)}${suffix}${inherited}`);
    }
  }

  const navs = getEffectiveNavigationProperties(entity, metadata.entities);
  if (navs.length > 0) {
    lines.push('\nNavigation Properties:');
    for (const nav of navs) {
      const target = nav.targetTypeQualified ?? nav.targetType;
      const inherited =
        nav.sourceType && nav.sourceType !== entity.name ? ` (from ${nav.sourceType})` : '';
      lines.push(`  - ${nav.name} -> ${target ?? nav.relationship}${inherited}`);
    }
  }

  const sets = getAllEntitySets(metadata).filter(
    (s) =>
      s.entityType === entity.name ||
      s.entityTypeQualified === entity.qualifiedName ||
      s.entityType === entity.qualifiedName,
  );
  if (sets.length > 0) {
    lines.push(`\nEntity Sets: ${sets.map((s) => s.name).join(', ')}`);
  }

  return lines.join('\n');
}

function formatEntitySet(set: ODataEntitySet): string {
  const flags: string[] = [];
  if (set.creatable) flags.push('create');
  if (set.updatable) flags.push('update');
  if (set.deletable) flags.push('delete');
  if (set.navigable) flags.push('navigate');
  const bindings = set.navigationPropertyBindings ?? [];
  const bindingStr =
    bindings.length > 0
      ? `; bindings: ${bindings.map((b) => `${b.path}->${b.target}`).join(', ')}`
      : '';
  return `${set.name} -> ${set.entityTypeQualified ?? set.entityType} [${flags.join(', ') || 'none'}]${bindingStr}`;
}

function formatParameter(
  param: ODataParameter,
  isFirstBinding: boolean,
  metadata: ODataMetadata,
): string {
  const binding = isFirstBinding && param.isBinding ? ' (binding)' : '';
  const nullable = param.nullable === false ? ' [required]' : '';
  return `  - ${param.name}: ${describeType(param.type, metadata)}${nullable}${binding}`;
}

function describeCallable(item: ODataAction | ODataFunction): string {
  const bound = item.isBound ? ' [bound]' : '';
  // The binding type is what makes a bound function discoverable as an edge:
  // `N.B [bound] -> N.C` alone never says the function is reachable from `A`.
  const binding = item.isBound ? (item.parameters ?? []).find((p) => p.isBinding) : undefined;
  const on = binding ? ` on ${binding.type}` : '';
  const ret = item.returnType ? ` -> ${item.returnType}` : '';
  return `${item.qualifiedName ?? item.name}${bound}${on}${ret}${item.label ? ` - ${item.label}` : ''}`;
}

function formatCallableDetails(
  item: ODataAction | ODataFunction,
  metadata: ODataMetadata,
  importName: string | undefined,
  baseUrl: string | undefined,
  isFunction: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    `${item.isBound ? 'Bound' : 'Unbound'} ${isFunction ? 'function' : 'action'}: ${item.qualifiedName ?? item.name}`,
  );
  if (item.label) lines.push(`Description: ${item.label}`);
  if (item.returnType) lines.push(`Return type: ${item.returnType}`);
  if (importName) lines.push(`Import: ${importName}`);

  lines.push('\nParameters:');
  (item.parameters ?? []).forEach((p) => lines.push(formatParameter(p, true, metadata)));
  if (!item.parameters || item.parameters.length === 0) lines.push('  (none)');

  const params = (item.parameters ?? []).filter((p) => !(item.isBound && p.isBinding));
  const example: Record<string, unknown> = {};
  for (const p of params) example[p.name] = sampleValue(p.type, metadata);

  lines.push('\nInvocation:');
  if (item.isBound) {
    // The binding parameter is the one flagged `isBinding`, the same rule the
    // invocation builder applies; index 0 only happens to be it today.
    const binding = (item.parameters ?? []).find((p) => p.isBinding);
    const bindingType = unwrapCollection(binding?.type);
    const elementType = bindingType?.type ?? 'Entity';
    const set = getAllEntitySets(metadata).find(
      (s) =>
        s.entityType === shortName(elementType) ||
        s.entityTypeQualified === shortName(elementType) ||
        s.entityType === elementType,
    );
    const setPath = set ? encodeIdentifierForUrl(set.name) : '<EntitySet>';
    const setEntity = set
      ? findEntityByName(metadata.entities, set.entityTypeQualified ?? set.entityType)
      : undefined;
    const keyNames = setEntity ? getEffectiveKeys(setEntity, metadata.entities) : [];
    const keyLiteral =
      keyNames.length > 0
        ? keyNames.length === 1
          ? `${encodeIdentifierForUrl(keyNames[0])}=<${encodeIdentifierForUrl(keyNames[0])}>`
          : keyNames
              .map((k) => `${encodeIdentifierForUrl(k)}=<${encodeIdentifierForUrl(k)}>`)
              .join(',')
        : '<key>';
    const root = baseUrl ? normalizeBaseUrl(baseUrl) : '<serviceRoot>';
    // A collection binding addresses the whole set; a key predicate would
    // compose on one entity instead of the collection the function binds to.
    const target = bindingType?.isCollection ? setPath : `${setPath}(${keyLiteral})`;
    lines.push(`  ${root}/${target}/${encodeIdentifierForUrl(item.qualifiedName ?? item.name)}`);
    if (set && !setEntity) {
      lines.push(
        `  Note: entity set "${set.name}" references type "${set.entityTypeQualified ?? set.entityType}", which is not defined in the loaded metadata.`,
      );
    }
  } else {
    const root = baseUrl ? normalizeBaseUrl(baseUrl) : '<serviceRoot>';
    lines.push(`  ${root}/${encodeIdentifierForUrl(importName ?? item.name)}`);
  }
  lines.push(`  Parameters: ${JSON.stringify(example)}`);
  lines.push(
    `  Use build_${isFunction ? 'function' : 'action'}_invocation to generate the full URL and body.`,
  );

  return lines.join('\n');
}

function shortName(qualified: string): string {
  const stripped = qualified.replace(/^Collection\(|\)$/g, '');
  return stripped.includes('.') ? stripped.split('.').pop()! : stripped;
}

function sampleValue(type: string, metadata: ODataMetadata): unknown {
  const collection = unwrapCollection(type);
  if (collection?.isCollection) return [sampleScalar(collection.type, metadata)];
  return sampleScalar(type, metadata);
}

function sampleScalar(type: string, metadata: ODataMetadata): unknown {
  if (type === 'Edm.Boolean') return true;
  if (type === 'Edm.Int16' || type === 'Edm.Int32' || type === 'Edm.Int64') return 0;
  if (type === 'Edm.Decimal' || type === 'Edm.Double' || type === 'Edm.Single') return 0;
  const enumType = metadata.enumTypes.find((e) => e.qualifiedName === type || e.name === type);
  if (enumType) return enumType.members[0]?.name ?? '';
  return 'string';
}

function buildKeySegment(
  entity: ODataEntity,
  metadata: ODataMetadata,
  keys: Record<string, string>,
): string {
  const keyNames = getEffectiveKeys(entity, metadata.entities);
  if (keyNames.length === 0) throw new Error('Entity has no key properties');
  const missing = keyNames.filter((k) => keys[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing key value(s): ${missing.join(', ')}`);
  }
  const properties = getEffectiveProperties(entity, metadata.entities);
  if (keyNames.length === 1) {
    const name = keyNames[0];
    const type = properties.find((p) => p.name === name)?.type;
    return `(${encodeLiteralForUrl(formatV4Literal(keys[name], type))})`;
  }
  return `(${keyNames
    .map((name) => {
      const type = properties.find((p) => p.name === name)?.type;
      return `${encodeIdentifierForUrl(name)}=${encodeLiteralForUrl(formatV4Literal(keys[name], type))}`;
    })
    .join(',')})`;
}

/**
 * What the JSON body needs while each parameter is coerced: whether the
 * IEEE754 string form is available for a value binary64 cannot carry, whether
 * the declared parameter puts every Int64/Decimal into that form, and whether
 * it was actually used, so the caller can declare the matching content type.
 */
interface BodyEncoding {
  ieee754Compatible: boolean;
  stringEncodeAll: boolean;
  stringEncodesIeee754: boolean;
  /** Current complex-value nesting depth; see `MAX_COMPLEX_DEPTH`. */
  complexDepth: number;
}

/**
 * How deep a complex value may nest before coercion refuses it. Recursion
 * follows the supplied value, so it is finite by construction; the bound only
 * turns a pathological payload — a cyclic type fed a correspondingly deep
 * value — into a clear error instead of a stack overflow.
 */
const MAX_COMPLEX_DEPTH = 64;

function coerceBodyValue(
  type: string,
  value: unknown,
  metadata: ODataMetadata,
  encoding: BodyEncoding,
  scope: string | undefined,
): unknown {
  const collection = unwrapCollection(type);
  if (collection?.isCollection) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((v) => coerceScalar(collection.type, v, metadata, encoding, scope));
  }
  return coerceScalar(type, value, metadata, encoding, scope);
}

/**
 * A decimal literal's value as sign, significant digits and power of ten, so
 * two spellings can be compared exactly: `1.50`, `15e-1` and `1.5` all become
 * `{ negative: false, digits: '15', exponent: -1 }`. Zero normalises to an
 * empty digit string, so `0`, `0.000` and `-0` compare equal.
 */
interface DecimalValue {
  negative: boolean;
  digits: string;
  exponent: number;
}

function parseDecimalValue(text: string): DecimalValue | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, intPart, fraction = '', exponentPart = '0'] = match;

  let digits = intPart + fraction;
  let exponent = Number(exponentPart) - fraction.length;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 0) return { negative: false, digits: '', exponent: 0 };

  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  return { negative: sign === '-', digits, exponent };
}

/** Do two decimal spellings denote the same decimal value? */
function denotesSameDecimal(left: string, right: string): boolean {
  const a = parseDecimalValue(left);
  const b = parseDecimalValue(right);
  if (!a || !b) return false;
  return a.negative === b.negative && a.digits === b.digits && a.exponent === b.exponent;
}

/**
 * A validated literal that binary64 cannot carry verbatim: emit it as a JSON
 * string when the IEEE754-compatible content type was chosen, and refuse it
 * under the plain content type, where a bare JSON number would lose digits.
 */
function encodeInexactNumber(
  type: string,
  value: unknown,
  literal: string,
  encoding: BodyEncoding,
): string {
  if (!encoding.ieee754Compatible) {
    throw new Error(
      `Invalid ${type} value: ${String(value)} (cannot be represented exactly as a JSON number)`,
    );
  }
  encoding.stringEncodesIeee754 = true;
  return literal;
}

/**
 * Find a type definition the way `findTypeInScope` finds an entity type:
 * exact qualified name, exact name in the preferred namespace, then
 * case-insensitive fallbacks. Definitions live outside `entities`, so they
 * need their own lookup rather than a call to `findTypeInScope`.
 */
function findTypeDefinition(
  metadata: ODataMetadata,
  type: string,
  scope: string | undefined,
): ODataTypeDefinition | undefined {
  const definitions = metadata.typeDefinitions;
  const exactQualified = definitions.find((t) => t.qualifiedName === type);
  if (exactQualified) return exactQualified;

  const exactScoped = definitions.find((t) => t.namespace === scope && t.name === type);
  if (exactScoped) return exactScoped;

  const needle = type.toLowerCase();
  const byQualified = definitions.find((t) => (t.qualifiedName ?? '').toLowerCase() === needle);
  if (byQualified) return byQualified;

  const sameNamespace = definitions.find(
    (t) => t.namespace?.toLowerCase() === scope?.toLowerCase() && t.name.toLowerCase() === needle,
  );
  if (sameNamespace) return sameNamespace;

  return definitions.find((t) => t.name.toLowerCase() === needle);
}

/**
 * Follow a type definition chain to the underlying type it names. CSDL forbids
 * a cycle, but a malformed model can still declare one and following it would
 * recurse forever, so the chain is walked iteratively and a repeated
 * definition is refused. The returning scope is the last definition's
 * namespace, which is where its underlying-type reference resolves.
 */
function resolveUnderlyingType(
  type: string,
  metadata: ODataMetadata,
  scope: string | undefined,
): { type: string; scope: string | undefined } {
  let current = type;
  let currentScope = scope;
  const seen = new Set<string>();
  for (;;) {
    const definition = findTypeDefinition(metadata, current, currentScope);
    if (!definition) return { type: current, scope: currentScope };
    const id = definition.qualifiedName ?? definition.name;
    if (seen.has(id)) {
      throw new Error(`Cyclic type definition: ${[...seen, id].join(' -> ')}`);
    }
    seen.add(id);
    current = definition.underlyingType;
    currentScope = definition.namespace ?? currentScope;
  }
}

/**
 * The complex type's own and inherited properties, base first, each paired
 * with the namespace of the type that declared it.
 *
 * `getEffectiveProperties` flattens the inheritance chain and drops the
 * declaring namespace, but an inherited property's type reference resolves in
 * the namespace of the type that declared it, not the derived type's — so the
 * chain is walked here instead.
 */
function effectiveComplexProperties(
  entity: ODataEntity,
  metadata: ODataMetadata,
): Array<{ property: ODataProperty; namespace: string | undefined }> {
  const seen = new Set<string>();
  const properties: Array<{ property: ODataProperty; namespace: string | undefined }> = [];
  for (const declaring of [...resolveInheritanceChain(entity, metadata.entities)].reverse()) {
    for (const property of declaring.properties) {
      if (seen.has(property.name)) continue;
      seen.add(property.name);
      properties.push({ property, namespace: declaring.namespace });
    }
  }
  return properties;
}

/**
 * Coerce a complex value member by member.
 *
 * Member names are matched exact-case first and then case-insensitively,
 * re-emitted under the declared spelling, exactly as top-level parameter names
 * are. A member the type does not declare is refused, mirroring
 * `assertKnownParameters` for an unknown top-level parameter — a typo would
 * otherwise reach the service as an unknown property. An open type carries
 * dynamic members, which are legal and pass through untouched. A value that is
 * not an object is refused: every scalar path validates its shape, and a
 * complex parameter is no different.
 */
function coerceComplex(
  entity: ODataEntity,
  value: unknown,
  metadata: ODataMetadata,
  encoding: BodyEncoding,
): unknown {
  const typeName = entity.qualifiedName ?? entity.name;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${typeName} value: ${JSON.stringify(value)} (expected an object)`);
  }

  encoding.complexDepth += 1;
  try {
    if (encoding.complexDepth > MAX_COMPLEX_DEPTH) {
      throw new Error(
        `Complex value for ${typeName} nests deeper than ${MAX_COMPLEX_DEPTH} levels; refusing to recurse further.`,
      );
    }

    const properties = effectiveComplexProperties(entity, metadata);
    const entries: Array<[string, unknown]> = [];
    for (const [name, member] of Object.entries(value)) {
      const declared =
        properties.find((p) => p.property.name === name) ??
        properties.find((p) => p.property.name.toLowerCase() === name.toLowerCase());
      if (!declared) {
        if (entity.openType) {
          entries.push([name, member]);
          continue;
        }
        throw new Error(
          `Unknown member "${name}" for complex type ${typeName}. Declared properties: ${
            properties.map((p) => p.property.name).join(', ') || '(none)'
          }.`,
        );
      }
      entries.push([
        declared.property.name,
        coerceBodyValue(declared.property.type, member, metadata, encoding, declared.namespace),
      ]);
    }
    // `Object.fromEntries` defines every key as an own data property, so a
    // dynamic member named `__proto__` survives instead of hitting an object
    // literal's prototype setter.
    return Object.fromEntries(entries);
  } finally {
    encoding.complexDepth -= 1;
  }
}

function coerceScalar(
  type: string,
  value: unknown,
  metadata: ODataMetadata,
  encoding: BodyEncoding,
  scope: string | undefined,
): unknown {
  if (value === null || value === undefined) return value;

  // Follow type definitions to the underlying EDM type before deciding how to
  // coerce. Complex types are resolved with the same scope rule the rest of
  // the tool uses, so a short name resolves the way CSDL scopes it. A type the
  // model cannot resolve passes through untouched: unresolved references are
  // expected in partially loaded models, so there is no schema to validate
  // against.
  const resolved = resolveUnderlyingType(type, metadata, scope);
  const complexType = findTypeInScope(metadata.entities, resolved.type, resolved.scope);
  if (complexType?.kind === 'complex') {
    return coerceComplex(complexType, value, metadata, encoding);
  }

  const edmType = resolved.type;
  if (edmType === 'Edm.Boolean') {
    if (typeof value === 'boolean') return value;
    const lowered = String(value).toLowerCase();
    if (lowered !== 'true' && lowered !== 'false') {
      throw new Error(`Invalid Edm.Boolean value: ${String(value)} (expected true or false)`);
    }
    return lowered === 'true';
  }

  if (
    edmType === 'Edm.Int16' ||
    edmType === 'Edm.Int32' ||
    edmType === 'Edm.Int64' ||
    edmType === 'Edm.Decimal' ||
    edmType === 'Edm.Double' ||
    edmType === 'Edm.Single' ||
    edmType === 'Edm.Byte' ||
    edmType === 'Edm.SByte'
  ) {
    // Syntax and EDM range checks come from the shared literal formatter —
    // the same `[sign] 1*10DIGIT` pattern and BigInt bounds #23 fixed for
    // query literals — so the body and the URL cannot disagree about what is
    // valid. The JSON body needs the number behind that literal, so convert
    // only after validation, and only when the conversion is exact: `Number`
    // would otherwise turn `1e999` into `Infinity` (JSON `null`) and silently
    // round Int64 values past 2^53. An inexact value is not refused outright:
    // under `application/json;IEEE754Compatible=true` its literal travels as
    // a JSON string, which the service reads back exactly.
    const literal = formatV4Literal(String(value), edmType);
    const num = Number(literal);
    if (!Number.isFinite(num)) {
      // `formatV4Literal` maps the string "null" to a null literal; in a JSON
      // body null is the value, never the string.
      throw new Error(`Invalid ${edmType} value: ${String(value)} (expected a number)`);
    }
    // OData JSON Format v4.01 §3.2 "Controlling the Representation of
    // Numbers": with IEEE754Compatible=true the service MUST serialize
    // Edm.Int64 and Edm.Decimal numbers as strings. The parameter is declared
    // for the whole body, so once any value forces the flip, every
    // Int64/Decimal in it — exact ones included, at every depth — takes the
    // string form rather than emitting a mixed payload.
    if (encoding.stringEncodeAll && (edmType === 'Edm.Int64' || edmType === 'Edm.Decimal')) {
      return literal;
    }
    if (INTEGER_TYPES.has(edmType) && BigInt(JSON.stringify(num)) !== BigInt(literal)) {
      // `BigInt(literal) !== BigInt(num)` is not enough: `num` can hold the
      // exact value while `JSON.stringify` prints the shortest round-tripping
      // decimal, which may use different digits (2^62 -> 4611686018427388000).
      // Integer EDM types are range-capped below 1e21, so `JSON.stringify`
      // never switches to exponent notation for them and `BigInt` always
      // parses the result. The set comes from the shared formatter so the
      // guard cannot drift out of step with the syntax it validated.
      return encodeInexactNumber(edmType, value, literal, encoding);
    }
    if (edmType === 'Edm.Decimal' && !denotesSameDecimal(literal, JSON.stringify(num))) {
      // Decimal is a decimal type, so the JSON text must denote the same
      // decimal the caller sent: `Number` may round it, and even when it does
      // not, `JSON.stringify` may print a different (shortest) spelling.
      return encodeInexactNumber(edmType, value, literal, encoding);
    }
    return num;
  }

  return value;
}

function declaredParameterType(
  item: ODataAction | ODataFunction,
  name: string,
): string | undefined {
  return item.parameters?.find((p) => p.name === name)?.type;
}

function formatFunctionParamLiteral(type: string, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const collection = unwrapCollection(type);
  if (collection?.isCollection) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((v) => formatV4Literal(String(v), collection.type)).join(',');
  }
  return formatV4Literal(String(value), type);
}

/** Escape a value for safe inclusion inside single quotes in a shell command. */
function shellEscape(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

export function createToolHandler(
  accessors: MetadataAccessors,
  options: ToolHandlerOptions = {},
): ToolHandler {
  const allowLoadMetadata = options.allowLoadMetadata ?? true;
  const ieee754Compatible = options.ieee754Compatible ?? true;
  const noMetadataMessage = allowLoadMetadata
    ? 'No metadata loaded. Call load_metadata first with a file path, URL, or the backend.'
    : 'No metadata loaded. Upload a file in the OData Visualizer UI first.';

  return async (name, args) => {
    const currentMetadata = accessors.get()?.metadata ?? null;
    const noMetadata = (): ToolResult => errorResult(noMetadataMessage);

    switch (name) {
      case 'load_metadata': {
        if (!allowLoadMetadata) {
          return errorResult(
            'load_metadata is disabled on this server. Metadata is supplied by the backend: upload a file in the OData Visualizer UI.',
          );
        }

        const source = asString(args['source']);
        const type = (args['type'] as MetadataSource['type']) ?? 'file';

        if (!source && type !== 'server') {
          return errorResult('Error: source is required');
        }

        try {
          const metadataSource: MetadataSource = { type, path: source };
          const metadata = await loadMetadataFromSource(metadataSource);
          accessors.set(metadata, {
            sourceName: source ?? 'backend',
            sourceType: type,
          });

          const preview = metadata.entities.slice(0, 10);
          const summary = [
            `Successfully loaded OData metadata from ${source ?? 'the backend'}`,
            '',
            `Version: ${metadata.version ?? 'unknown'}`,
            `Entities: ${metadata.entities.length} (${metadata.entities.filter((e) => e.kind === 'complex').length} complex types)`,
            `Entity sets: ${getAllEntitySets(metadata).length}`,
            `Actions: ${metadata.actions.length}`,
            `Functions: ${metadata.functions.length}`,
            `Enums: ${metadata.enumTypes.length}`,
            `Relationships: ${metadata.relationships.length}`,
            ...(metadata.unresolvedReferences?.length
              ? [
                  '',
                  `Warning: unresolved references: ${metadata.unresolvedReferences.join(', ')} (some types may be missing)`,
                ]
              : []),
            '',
            'First entities:',
            ...preview.map((e) => `  - ${formatEntitySummary(e, metadata)}`),
            metadata.entities.length > preview.length
              ? `  ... and ${metadata.entities.length - preview.length} more (use list_entities or search_entities)`
              : '',
          ]
            .filter((line) => line !== '')
            .join('\n');

          return textResult(summary);
        } catch (error) {
          return errorResult(
            `Error loading metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      case 'get_metadata_status': {
        const stored = accessors.get();
        if (!stored) {
          return textResult(
            allowLoadMetadata
              ? 'No metadata loaded. Upload a file in the OData Visualizer UI or call load_metadata.'
              : 'No metadata loaded. Upload a file in the OData Visualizer UI.',
          );
        }
        const { metadata, info } = stored;
        const lines = [
          'Metadata loaded:',
          `  Source: ${info.sourceName ?? 'unknown'} (${info.sourceType ?? 'unknown'})`,
          `  Loaded: ${info.loadedAt}`,
          `  Entities: ${metadata.entities.length}`,
          `  Entity sets: ${getAllEntitySets(metadata).length}`,
          `  Actions: ${metadata.actions.length}`,
          `  Functions: ${metadata.functions.length}`,
          `  Enums: ${metadata.enumTypes.length}`,
          `  Relationships: ${metadata.relationships.length}`,
        ];
        if (metadata.unresolvedReferences?.length) {
          lines.push(
            `  Unresolved references: ${metadata.unresolvedReferences.join(', ')} (some types may be missing)`,
          );
        }
        return textResult(lines.join('\n'));
      }

      case 'search_entities': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const query = (asString(args['query']) ?? '').toLowerCase();
        if (!query) return errorResult('Error: query is required');
        const limit = Math.min(MAX_LIMIT, Math.max(1, asNumber(args['limit']) ?? 20));

        const scored = metadata.entities
          .map((entity) => {
            const names = [
              entity.name.toLowerCase(),
              (entity.qualifiedName ?? '').toLowerCase(),
              (entity.label ?? '').toLowerCase(),
            ];
            let score = -1;
            if (names.some((n) => n === query)) score = 0;
            else if (names.some((n) => n.startsWith(query))) score = 1;
            else if (names.some((n) => n.includes(query))) score = 2;
            else if (hasEffectiveProperty(entity, metadata.entities, (name) => name === query))
              score = 3;
            else if (
              hasEffectiveNavigation(entity, metadata.entities, (name) => name.includes(query))
            )
              score = 4;
            else if (
              Object.values(entity.annotations ?? {}).some((v) => v.toLowerCase().includes(query))
            )
              score = 5;
            return { entity, score };
          })
          .filter((s) => s.score >= 0)
          .sort((a, b) => a.score - b.score)
          .slice(0, limit);

        if (scored.length === 0) {
          const suggestions = suggestNames(
            query,
            metadata.entities.map((e) => e.name),
          );
          return textResult(
            `No entities matching "${query}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }

        const lines = scored.map((s) => formatEntitySummary(s.entity, metadata));
        return textResult(`Found ${scored.length} matching entities:\n\n${lines.join('\n')}`);
      }

      case 'list_entities': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const kind = asString(args['kind']) ?? 'all';
        let entities = metadata.entities;
        if (kind === 'complex') entities = entities.filter((e) => e.kind === 'complex');
        if (kind === 'entity') entities = entities.filter((e) => e.kind !== 'complex');

        if (entities.length === 0) {
          return textResult('No entities found in the metadata.');
        }

        const { slice, note } = paginate(entities, args);
        const list = slice.map((e) => formatEntitySummary(e, metadata)).join('\n');
        return textResult(`Entities:\n\n${list}${note}`);
      }

      case 'get_entity_details': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const entityName = asString(args['entityName']);
        if (!entityName) return errorResult('Error: entityName is required');

        const resolved = resolveEntityArg(metadata, entityName);
        if ('error' in resolved) return resolved.error;

        return textResult(formatEntityDetails(resolved.entity, metadata));
      }

      case 'list_entity_sets': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const sets = getAllEntitySets(metadata);
        if (sets.length === 0) return textResult('No entity sets found in the metadata.');

        const { slice, note } = paginate(sets, args);
        const list = slice.map((s) => formatEntitySet(s)).join('\n');
        return textResult(`Entity sets:\n\n${list}${note}`);
      }

      case 'get_relationships': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const entityName = asString(args['entityName']);
        let rels = metadata.relationships;
        if (entityName) {
          // Endpoints store the qualified identity. Match the argument against
          // the identity, its short name, and the resolved entity's names, so a
          // qualified argument reaches its own namespace rather than whichever
          // same-named type the old `.find((e) => e.name === ...)` saw first.
          const namesFor = (end: ODataAssociationEnd): string[] => {
            const identity = end.entityQualified ?? end.entity;
            const short = identity.includes('.')
              ? identity.slice(identity.lastIndexOf('.') + 1)
              : identity;
            const entity = findEntityByName(metadata.entities, identity);
            return [identity, short, end.entity, entity?.name ?? '', entity?.qualifiedName ?? ''];
          };
          rels = matchNames(rels, entityName, (r) => [...namesFor(r.from), ...namesFor(r.to)]);
        }

        // Bound functions are not stored in `metadata.relationships`, so the
        // one tool an agent would call to ask "what connects A to C" never
        // mentioned them. They are edges in the traversal graph, and this is
        // where that graph becomes visible. The same exact-case-first policy
        // applies: a bound function's namespace is part of the question.
        const edgeNamesFor = (identity: string): string[] => {
          const entity = findEntityByName(metadata.entities, identity);
          return [identity, entity?.name ?? '', entity?.qualifiedName ?? ''];
        };
        let operationEdges = getTraversalEdges(metadata).filter(isFunctionEdge);
        if (entityName) {
          operationEdges = matchNames(operationEdges, entityName, (edge) => [
            ...edgeNamesFor(edge.from),
            ...edgeNamesFor(edge.to),
          ]);
        }

        if (rels.length === 0 && operationEdges.length === 0) {
          return textResult(
            entityName
              ? `No relationships found for "${entityName}".`
              : 'No relationships found in the metadata.',
          );
        }

        const sections: string[] = [];
        if (rels.length > 0) {
          const { slice, note } = paginate(rels, args);
          sections.push(`Relationships:\n\n${slice.map(formatRelationship).join('\n')}${note}`);
        }
        if (operationEdges.length > 0) {
          const { slice, note } = paginate(operationEdges, args);
          sections.push(
            `Operation edges:\n\n${slice.map((edge) => formatOperationEdge(edge, metadata)).join('\n')}${note}`,
          );
        }
        return textResult(sections.join('\n\n'));
      }

      case 'list_actions': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const boundArg = args['bound'];
        let actions = metadata.actions;
        if (typeof boundArg === 'boolean') actions = actions.filter((a) => a.isBound === boundArg);
        if (actions.length === 0) return textResult('No actions found in the metadata.');

        const { slice, note } = paginate(actions, args);
        const list = slice.map((a) => describeCallable(a)).join('\n');
        return textResult(`Actions:\n\n${list}${note}`);
      }

      case 'list_functions': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const boundArg = args['bound'];
        let functions = metadata.functions;
        if (typeof boundArg === 'boolean')
          functions = functions.filter((f) => f.isBound === boundArg);
        if (functions.length === 0) return textResult('No functions found in the metadata.');

        const { slice, note } = paginate(functions, args);
        const list = slice.map((f) => describeCallable(f)).join('\n');
        return textResult(`Functions:\n\n${list}${note}`);
      }

      case 'get_action_details': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const actionName = asString(args['name']);
        if (!actionName) return errorResult('Error: name is required');

        const actions = findCallableCandidates(metadata.actions, actionName);
        if (actions.length === 0) {
          const suggestions = suggestNames(
            actionName,
            metadata.actions.map((a) => a.name),
          );
          return errorResult(
            `Action "${actionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }
        const baseUrl = asString(args['baseUrl']);
        try {
          const details = actions.map((action) => {
            const importName = metadata.actionImports.find(
              (i) => i.qualifiedActionName === action.qualifiedName || i.actionName === action.name,
            )?.name;
            return formatCallableDetails(action, metadata, importName, baseUrl, false);
          });
          return textResult(formatOverloadDetails(details));
        } catch (error) {
          return errorResult(
            `Error building invocation sketch: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      case 'get_function_details': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const functionName = asString(args['name']);
        if (!functionName) return errorResult('Error: name is required');

        const funcs = findCallableCandidates(metadata.functions, functionName);
        if (funcs.length === 0) {
          const suggestions = suggestNames(
            functionName,
            metadata.functions.map((f) => f.name),
          );
          return errorResult(
            `Function "${functionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }
        const baseUrl = asString(args['baseUrl']);
        try {
          const details = funcs.map((func) => {
            const importName = metadata.functionImports.find(
              (i) => i.qualifiedFunctionName === func.qualifiedName || i.functionName === func.name,
            )?.name;
            return formatCallableDetails(func, metadata, importName, baseUrl, true);
          });
          return textResult(formatOverloadDetails(details));
        } catch (error) {
          return errorResult(
            `Error building invocation sketch: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      case 'list_enums': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const lines: string[] = [];

        if (metadata.enumTypes.length > 0) {
          lines.push('Enum Types:');
          for (const e of metadata.enumTypes) {
            lines.push(
              `  - ${e.qualifiedName ?? e.name} (${e.underlyingType}): ${e.members
                .map((m) => (m.value ? `${m.name}=${m.value}` : m.name))
                .join(', ')}`,
            );
          }
        }

        if (metadata.typeDefinitions.length > 0) {
          lines.push('\nType Definitions:');
          for (const t of metadata.typeDefinitions) {
            lines.push(`  - ${t.qualifiedName ?? t.name}: ${t.underlyingType}`);
          }
        }

        if (lines.length === 0) return textResult('No enum types or type definitions found.');
        return textResult(lines.join('\n'));
      }

      case 'build_query': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const entitySet = asString(args['entitySet']);
        if (!entitySet) return errorResult('Error: entitySet is required');

        const warnings: string[] = [];
        try {
          const url = buildQueryUrl({
            entitySet,
            baseUrl: asString(args['baseUrl']),
            filters: args['filters'] as FilterClause[] | undefined,
            filterLogic: args['filterLogic'] as 'and' | 'or' | undefined,
            select: args['select'] as string[] | undefined,
            expand: args['expand'] as ExpandNode[] | undefined,
            groupBy: args['groupBy'] as QueryOptions['groupBy'],
            aggregates: args['aggregates'] as QueryOptions['aggregates'],
            orderBy: asString(args['orderBy']),
            top: asNumber(args['top']),
            skip: asNumber(args['skip']),
            count: typeof args['count'] === 'boolean' ? args['count'] : undefined,
            search: asString(args['search']),
            metadata,
            onWarning: (message) => warnings.push(message),
          });

          if (!findEntitySet(metadata, resourcePathOf(entitySet))) {
            const suggestions = suggestNames(
              resourcePathOf(entitySet),
              getAllEntitySets(metadata).map((s) => s.name),
            );
            warnings.push(
              `Note: "${entitySet}" is not a known entity set.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
            );
          }

          const lines = [`GET ${url}`];
          if (warnings.length > 0) lines.push('', ...warnings);
          return textResult(lines.join('\n'));
        } catch (error) {
          return errorResult(
            `Error building query: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      case 'build_action_invocation': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const actionName = asString(args['actionName']);
        if (!actionName) return errorResult('Error: actionName is required');

        const candidates = findCallableCandidates(metadata.actions, actionName);
        if (candidates.length === 0) {
          const suggestions = suggestNames(
            actionName,
            metadata.actions.map((a) => a.name),
          );
          return errorResult(
            `Action "${actionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }

        const bound = narrowCandidatesByEntitySet(
          candidates,
          metadata,
          asString(args['entitySet']),
          actionName,
        );
        if (!Array.isArray(bound)) return bound;

        const rawParameters = (args['parameters'] as Record<string, unknown> | undefined) ?? {};
        const action = selectCallableOverload(
          bound,
          rawParameters,
          bound.length < candidates.length,
        );
        if (action.kind === 'ambiguous') {
          return errorResult(
            `Ambiguous invocation of "${actionName}": more than one overload accepts the supplied parameters. Overloads: ${formatOverloadSignatures(action.items)}.`,
          );
        }
        if (action.kind === 'none') {
          return errorResult(
            `No overload of "${actionName}" accepts the supplied parameters. Overloads: ${formatOverloadSignatures(candidates)}.`,
          );
        }

        return buildInvocation('POST', action.item, metadata, args, false, ieee754Compatible);
      }

      case 'build_function_invocation': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const functionName = asString(args['functionName']);
        if (!functionName) return errorResult('Error: functionName is required');

        const candidates = findCallableCandidates(metadata.functions, functionName);
        if (candidates.length === 0) {
          const suggestions = suggestNames(
            functionName,
            metadata.functions.map((f) => f.name),
          );
          return errorResult(
            `Function "${functionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }

        const bound = narrowCandidatesByEntitySet(
          candidates,
          metadata,
          asString(args['entitySet']),
          functionName,
        );
        if (!Array.isArray(bound)) return bound;

        const rawParameters = (args['parameters'] as Record<string, unknown> | undefined) ?? {};
        const func = selectCallableOverload(bound, rawParameters, bound.length < candidates.length);
        if (func.kind === 'ambiguous') {
          return errorResult(
            `Ambiguous invocation of "${functionName}": more than one overload accepts the supplied parameters. Overloads: ${formatOverloadSignatures(func.items)}.`,
          );
        }
        if (func.kind === 'none') {
          return errorResult(
            `No overload of "${functionName}" accepts the supplied parameters. Overloads: ${formatOverloadSignatures(candidates)}.`,
          );
        }

        return buildInvocation('GET', func.item, metadata, args, true, ieee754Compatible);
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  };
}

const defaultHandler = createToolHandler(defaultStore);

export const handleToolCall: ToolHandler = (name, args) => defaultHandler(name, args);

/** Every overload the name resolves to, in declaration order. */
function findCallableCandidates<T extends ODataAction | ODataFunction>(
  items: T[],
  name: string,
): T[] {
  // #40's policy, applied here: an exact-case `qualifiedName` wins, then an
  // exact-case `name`, and the lowercased comparison is only the fallback.
  // Lowercasing first let `SHOP.DoIt` answer with `Shop.DoIt` — and its return
  // type — whenever the two schemas differed only in case, so an agent built an
  // invocation against the wrong operation signature.
  const exactQualified = items.filter((i) => i.qualifiedName === name);
  if (exactQualified.length > 0) return exactQualified;
  const exactName = items.filter((i) => i.name === name);
  if (exactName.length > 0) return exactName;
  const needle = name.toLowerCase();
  const caseInsensitive = items.filter(
    (i) => (i.qualifiedName ?? '').toLowerCase() === needle || i.name.toLowerCase() === needle,
  );
  if (caseInsensitive.length > 0) return caseInsensitive;
  return items.filter((i) => i.name.toLowerCase() === shortName(name).toLowerCase());
}

/** A candidate that survived binding-type narrowing, with how derived it is. */
interface OverloadCandidate<T extends ODataAction | ODataFunction> {
  item: T;
  /** Steps from the entity set's type to the binding type (0 = the set's own type). */
  bindingDepth: number;
}

/** The outcome of matching supplied parameter names against overloads. */
type OverloadSelection<T extends ODataAction | ODataFunction> =
  { kind: 'selected'; item: T } | { kind: 'ambiguous'; items: T[] } | { kind: 'none' };

/**
 * Pick the overload that matches the supplied parameter names.
 *
 * OData V4.01 Part 1 "Function overload resolution" selects a function overload whose declared
 * parameter set matches the supplied names before anything else, so the
 * fewest declared parameters wins and a superset cannot shadow an exact match
 * (#65). Binding-type specificity breaks an arity tie: "Binding an Operation to a Resource" lets a
 * candidate bound to a base type stay invocable through a derived entity set,
 * but "Function overload resolution" selects by the type of the URL segment, which is the set's own
 * type, so the candidate bound to the most derived type wins (lowest
 * `bindingDepth`). A genuine tie — same binding depth and same parameter count
 * — is refused as ambiguous, mirroring the service-side rule ("Services SHOULD
 * avoid ambiguity ... MAY return 400") instead of silently picking by
 * declaration order and emitting a "not supplied" note for a parameter the
 * caller never meant to send. Declaration order only orders the reported
 * candidates.
 *
 * `requireCoverage` is set when binding-type narrowing removed candidates: a
 * lone survivor then still has to cover the supplied names, so a typo keeps
 * the overload listing instead of being downgraded to a single-signature
 * "Unknown parameter" error with no way to see the alternatives. A name that
 * had a single declaration all along is returned as-is (when it covers), so
 * that error keeps naming the operation's own parameters.
 */
function selectCallableOverload<T extends ODataAction | ODataFunction>(
  candidates: OverloadCandidate<T>[],
  parameters: Record<string, unknown>,
  requireCoverage: boolean,
): OverloadSelection<T> {
  const supplied = Object.keys(parameters).map((name) => name.toLowerCase());
  const covering = candidates.filter((candidate) =>
    supplied.every((name) =>
      (candidate.item.parameters ?? []).some((p) => p.name.toLowerCase() === name),
    ),
  );
  if (covering.length === 0) {
    if (!requireCoverage && candidates.length === 1) {
      return { kind: 'selected', item: candidates[0].item };
    }
    return { kind: 'none' };
  }
  const parameterCount = (candidate: OverloadCandidate<T>): number =>
    (candidate.item.parameters ?? []).length;
  const arity = Math.min(...covering.map(parameterCount));
  const exact = covering.filter((candidate) => parameterCount(candidate) === arity);
  const bindingDepth = Math.min(...exact.map((candidate) => candidate.bindingDepth));
  const mostDerived = exact.filter((candidate) => candidate.bindingDepth === bindingDepth);
  if (mostDerived.length > 1) {
    return { kind: 'ambiguous', items: mostDerived.map((candidate) => candidate.item) };
  }
  return { kind: 'selected', item: mostDerived[0].item };
}

/**
 * How far a bound callable's binding type sits from the entity set's type in
 * the inheritance chain, or `undefined` when the set cannot invoke it.
 *
 * OData V4.01 Part 1 "Binding an Operation to a Resource": an operation bound to a type is invocable
 * through a resource whose type is that type or a type derived from it.
 * "Function overload resolution" (functions) and "Action Overload Resolution" (actions) then select the overload by
 * the type of the URL segment, so this depth is the binding-type specificity
 * signal: 0 is the set's own type and larger numbers are further up its
 * inheritance chain. Unbound callables rank 0.
 *
 * A binding type the model does not resolve (`Edm.EntityType`, an alias from
 * another document) is invocable in principle and still passes the filter, but
 * it cannot be ranked and must never outrank a resolved candidate, so it ranks
 * `Infinity`; ranking it 0 made it look like the set's own type and let it win
 * ahead of a resolved base type. An unresolvable set type ranks everyone 0,
 * since no depth can be computed at all.
 */
function bindingDepthForSet(
  item: ODataAction | ODataFunction,
  set: ODataEntitySet,
  metadata: ODataMetadata,
): number | undefined {
  if (!item.isBound) return 0;
  const bindingElement = unwrapCollection(
    (item.parameters ?? []).find((p) => p.isBinding)?.type,
  )?.type;
  if (!bindingElement) return Number.POSITIVE_INFINITY;
  const bindingType = findTypeInScope(metadata.entities, bindingElement, item.namespace);
  const setType = findEntityByName(metadata.entities, set.entityTypeQualified ?? set.entityType);
  if (!setType) return 0;
  if (!bindingType) return Number.POSITIVE_INFINITY;
  const depth = resolveInheritanceChain(setType, metadata.entities).indexOf(bindingType);
  return depth >= 0 ? depth : undefined;
}

/**
 * Narrow overload candidates to the ones the supplied entity set can invoke,
 * recording how derived each candidate's binding type is.
 *
 * CSDL allows bound functions and actions to overload by binding type, so a
 * candidate bound to an unrelated type must not win on parameter names alone —
 * it would type the literals with the wrong signature. A set whose type is not
 * a binding type of any candidate is refused rather than composed into a path
 * the service would reject.
 */
function narrowCandidatesByEntitySet<T extends ODataAction | ODataFunction>(
  candidates: T[],
  metadata: ODataMetadata,
  entitySetName: string | undefined,
  name: string,
): OverloadCandidate<T>[] | ToolResult {
  const unranked = (): OverloadCandidate<T>[] =>
    candidates.map((item) => ({ item, bindingDepth: 0 }));
  if (!entitySetName) return unranked();
  const set = findEntitySet(metadata, entitySetName);
  // An unknown set is reported by the invocation path with its suggestions.
  if (!set) return unranked();
  const matching: OverloadCandidate<T>[] = [];
  for (const item of candidates) {
    const bindingDepth = bindingDepthForSet(item, set, metadata);
    if (bindingDepth !== undefined) matching.push({ item, bindingDepth });
  }
  if (matching.length > 0) return matching;
  return errorResult(
    `No overload of "${name}" is bound to entity set "${set.name}" (type ${
      set.entityTypeQualified ?? set.entityType
    }). Overloads: ${formatOverloadSignatures(candidates)}.`,
  );
}

/** `N.B(it); N.B(it, factor)` — every overload with its declared parameters. */
function formatOverloadSignatures(items: Array<ODataAction | ODataFunction>): string {
  return items
    .map(
      (item) =>
        `${item.qualifiedName ?? item.name}(${(item.parameters ?? []).map((p) => p.name).join(', ')})`,
    )
    .join('; ');
}

/**
 * Render one detail block per overload, labelled when a name resolves to more
 * than one, so the details tools show every signature rather than the first.
 */
function formatOverloadDetails(details: string[]): string {
  if (details.length <= 1) return details.join('');
  return details
    .map((detail, index) => `Overload ${index + 1} of ${details.length}:\n${detail}`)
    .join('\n\n');
}

function buildInvocation(
  method: 'GET' | 'POST',
  item: ODataAction | ODataFunction,
  metadata: ODataMetadata,
  args: Record<string, unknown>,
  isFunction: boolean,
  ieee754Compatible: boolean,
): ToolResult {
  try {
    return buildInvocationUnsafe(method, item, metadata, args, isFunction, ieee754Compatible);
  } catch (error) {
    const label = isFunction ? 'function' : 'action';
    return errorResult(
      `Error building ${label} invocation: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Binding parameters identify the target resource in the URL and must never be
 * sent in the request body or repeated as inline function parameters.
 */
function invokableParameters(item: ODataAction | ODataFunction): ODataParameter[] {
  return (item.parameters ?? []).filter((p) => !p.isBinding);
}

function assertKnownParameters(
  item: ODataAction | ODataFunction,
  parameters: Record<string, unknown>,
): void {
  const declared = new Map(
    (item.parameters ?? []).map((p) => [p.name.toLowerCase(), p.name] as const),
  );
  const unknown = Object.keys(parameters).filter((name) => !declared.has(name.toLowerCase()));
  if (unknown.length === 0) return;

  const binding = (item.parameters ?? []).find((p) => p.isBinding);
  const ignored = binding
    ? ` The binding parameter "${binding.name}" is sent in the URL, not the body.`
    : '';
  throw new Error(
    `Unknown parameter "${unknown.join('", "')}" for ${item.name}. Declared parameters: ${
      (item.parameters ?? []).map((p) => p.name).join(', ') || '(none)'
    }.${ignored}`,
  );
}

function buildInvocationUnsafe(
  method: 'GET' | 'POST',
  item: ODataAction | ODataFunction,
  metadata: ODataMetadata,
  args: Record<string, unknown>,
  isFunction: boolean,
  ieee754Compatible: boolean,
): ToolResult {
  const entitySetName = asString(args['entitySet']);
  const keys = (args['keys'] as Record<string, string> | undefined) ?? {};
  const rawParameters = (args['parameters'] as Record<string, unknown> | undefined) ?? {};
  const baseUrl = asString(args['baseUrl']);
  const root = baseUrl ? normalizeBaseUrl(baseUrl) : '<serviceRoot>';

  assertKnownParameters(item, rawParameters);

  // Copy using the declared parameter names so a differently-cased input name
  // still maps onto the right parameter.
  const providedByLowerName = new Map(
    Object.entries(rawParameters).map(([key, value]) => [key.toLowerCase(), value] as const),
  );
  const parameters: Record<string, unknown> = {};
  for (const param of invokableParameters(item)) {
    if (providedByLowerName.has(param.name.toLowerCase())) {
      parameters[param.name] = providedByLowerName.get(param.name.toLowerCase());
    }
  }

  const binding = (item.parameters ?? []).find((p) => p.isBinding);
  const bindingIsCollection = unwrapCollection(binding?.type)?.isCollection ?? false;
  const notes: string[] = [];

  let path: string;
  if (item.isBound) {
    if (!entitySetName) {
      return errorResult(
        bindingIsCollection
          ? `Error: "${item.name}" is bound to a collection; entitySet is required to form the resource path.`
          : `Error: "${item.name}" is bound; entitySet and keys are required to form the resource path.`,
      );
    }
    const set = findEntitySet(metadata, entitySetName);
    if (!set) {
      const suggestions = suggestNames(
        entitySetName,
        getAllEntitySets(metadata).map((s) => s.name),
      );
      return errorResult(
        `Entity set "${entitySetName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
      );
    }
    if (bindingIsCollection) {
      // The binding parameter addresses the whole collection, so no key
      // predicate may be spliced in; supplied keys are ignored rather than
      // silently composing on one entity of the collection — and the caller
      // is told so, rather than left wondering where they went.
      if (Object.keys(keys).length > 0) {
        notes.push(
          `Note: keys were ignored because "${item.name}" is bound to the collection "${set.name}"; the invocation addresses the whole set.`,
        );
      }
      path = `${encodeIdentifierForUrl(set.name)}/${encodeIdentifierForUrl(item.qualifiedName ?? item.name)}`;
    } else {
      const entity = findEntityByName(metadata.entities, set.entityTypeQualified ?? set.entityType);
      if (!entity) {
        return errorResult(`Could not resolve entity type for entity set "${entitySetName}".`);
      }
      let keySegment: string;
      try {
        keySegment = buildKeySegment(entity, metadata, keys);
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : 'Invalid keys'}`);
      }
      path = `${encodeIdentifierForUrl(set.name)}${keySegment}/${encodeIdentifierForUrl(item.qualifiedName ?? item.name)}`;
    }
  } else {
    const importName = isFunction
      ? metadata.functionImports.find(
          (i) => i.qualifiedFunctionName === item.qualifiedName || i.functionName === item.name,
        )?.name
      : metadata.actionImports.find(
          (i) => i.qualifiedActionName === item.qualifiedName || i.actionName === item.name,
        )?.name;
    // V4 addresses an unbound operation by its import name, or by the
    // qualified operation name when no import exists.
    path = encodeIdentifierForUrl(importName ?? item.qualifiedName ?? item.name);
  }

  const inline = isFunction ? formatInlineParams(item, parameters) : '';
  const queryWarnings: string[] = [];
  const queryOptions = isFunction
    ? buildFunctionQueryOptions(item, metadata, args, queryWarnings)
    : '';
  // A function with no parameters is emitted without parentheses today
  // (`As('1')/N.B`). Once query options follow, the parentheses are added so
  // the result is the unambiguous `As('1')/N.B()?$select=...` of the OData V4
  // URL conventions — and so the terminal form stays byte-for-byte unchanged.
  const segment = `${path}${inline}${queryOptions && !inline ? '()' : ''}`;
  const fullPath = `${segment}${queryOptions}`;

  const missingWarnings = missingParameterWarnings(
    item,
    invokableParameters(item)
      .filter((p) => !providedByLowerName.has(p.name.toLowerCase()))
      .map((p) => p.name),
  );

  const lines: string[] = [];
  lines.push(`${method} ${root}/${fullPath}`);

  if (isFunction) {
    if (Object.keys(parameters).length > 0) {
      lines.push('Parameters: inline in the URL (see above).');
    }
    lines.push('');
    lines.push('Example:');
    lines.push(`curl '${shellEscape(`${root}/${fullPath}`)}'`);
    if (queryWarnings.length > 0 || missingWarnings.length > 0 || notes.length > 0) {
      lines.push('', ...queryWarnings, ...missingWarnings, ...notes);
    }
    return textResult(lines.join('\n'));
  }

  const { body, contentType } = buildBody(item, parameters, metadata, ieee754Compatible);
  lines.push(`Content-Type: ${contentType}`);
  lines.push('');
  lines.push('Body:');
  lines.push(JSON.stringify(body, null, 2));
  lines.push('');
  lines.push('Example:');
  lines.push(
    [
      `curl -X ${method}`,
      `  '${shellEscape(`${root}/${fullPath}`)}'`,
      `  -H 'Content-Type: ${contentType}'`,
      `  -d '${shellEscape(JSON.stringify(body))}'`,
    ].join(' \\\n'),
  );
  if (missingWarnings.length > 0 || notes.length > 0) {
    lines.push('', ...missingWarnings, ...notes);
  }

  return textResult(lines.join('\n'));
}

/**
 * A declared non-binding parameter the caller left out. The parser does not
 * record `DefaultValue`, so every one of them is treated as required; the
 * invocation is still emitted, with a note, because the URL remains useful
 * even when a parameter value has to be filled in later.
 */
function missingParameterWarnings(item: ODataAction | ODataFunction, missing: string[]): string[] {
  if (missing.length === 0) return [];
  const names = missing.map((name) => `"${name}"`).join(', ');
  return [
    `Note: ${missing.length === 1 ? 'parameter' : 'parameters'} ${names} ${
      missing.length === 1 ? 'was' : 'were'
    } not supplied for ${item.qualifiedName ?? item.name}; the request may be rejected.`,
  ];
}

function formatInlineParams(
  item: ODataAction | ODataFunction,
  parameters: Record<string, unknown>,
): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return '';
  const rendered = entries.map(([name, value]) => {
    const type = declaredParameterType(item, name);
    const literal = type ? formatFunctionParamLiteral(type, value) : formatV4Literal(String(value));
    // Only the value is encoded; the `name=` and the joining commas are OData
    // syntax, not data. The name itself is metadata-derived, so it is encoded
    // for the identifier position rather than emitted verbatim.
    return `${encodeIdentifierForUrl(name)}=${encodeLiteralForUrl(literal)}`;
  });
  return `(${rendered.join(',')})`;
}

/**
 * The shape of a function's return: whether it is structured (entity or
 * complex), the structured type it resolves to when the model names one, and
 * whether the return is a collection.
 *
 * `$select`/`$expand` need a structured result; paging, filtering and ordering
 * additionally need a collection (OData V4.01 Part 2 §5.1). Keeping the facets
 * apart is what lets a single complex return keep the former and drop the
 * latter, while a collection of primitives keeps the latter and drops the
 * former. `Edm.EntityType` and `Edm.ComplexType` are abstract structured types,
 * so their values accept `$select`/`$expand` even though no concrete type can
 * be resolved to validate property names.
 */
function functionReturnShape(
  item: ODataAction | ODataFunction,
  metadata: ODataMetadata,
): { structured: boolean; structuredName?: string; isCollection: boolean } {
  const returnType = unwrapCollection(item.returnType);
  if (!returnType) return { structured: false, isCollection: false };
  if (returnType.type === 'Edm.EntityType' || returnType.type === 'Edm.ComplexType') {
    return { structured: true, isCollection: returnType.isCollection };
  }
  if (returnType.type.startsWith('Edm.')) {
    return { structured: false, isCollection: returnType.isCollection };
  }
  const resolved = findTypeInScope(metadata.entities, returnType.type, item.namespace);
  return {
    structured: resolved !== undefined,
    structuredName: resolved ? (resolved.qualifiedName ?? resolved.name) : undefined,
    isCollection: returnType.isCollection,
  };
}

/**
 * Render the system query options a caller attached to a function invocation,
 * or `''` when none were requested — so the terminal form is unchanged.
 *
 * A function segment is a resource path, and OData V4 allows
 * `As('1')/N.B()?$select=...&$expand=...`; the options are typed against the
 * function's return type through the same `buildQueryOptions` the query
 * builder uses.
 *
 * When the function does not return a structured (entity or complex) value,
 * `$select`/`$expand` cannot apply at all, and a scalar result has no
 * collection to filter, sort or page: those options are dropped with a warning
 * rather than rendered into a URL the service would reject.
 */
function buildFunctionQueryOptions(
  item: ODataAction | ODataFunction,
  metadata: ODataMetadata,
  args: Record<string, unknown>,
  warnings: string[],
): string {
  let select = args['select'] as string[] | undefined;
  let expand = args['expand'] as ExpandNode[] | undefined;
  let filters = args['filters'] as FilterClause[] | undefined;
  const filterLogic = args['filterLogic'] as 'and' | 'or' | undefined;
  let orderBy = asString(args['orderBy']);
  let top = asNumber(args['top']);
  let skip = asNumber(args['skip']);
  let count = typeof args['count'] === 'boolean' ? args['count'] : undefined;

  const returnShape = functionReturnShape(item, metadata);
  const structured = returnShape.structured;
  const omitted: string[] = [];
  const drop = (name: string): void => {
    omitted.push(name);
  };
  // $select/$expand need a structured result; filtering, sorting and paging
  // need a collection — a collection of primitives is still a collection,
  // while a single entity or complex value is not.
  if (!structured) {
    if ((select?.length ?? 0) > 0) {
      drop('$select');
      select = undefined;
    }
    if ((expand?.length ?? 0) > 0) {
      drop('$expand');
      expand = undefined;
    }
  }
  if (!returnShape.isCollection) {
    if ((filters?.length ?? 0) > 0) {
      drop('$filter');
      filters = undefined;
    }
    if (orderBy !== undefined) {
      drop('$orderby');
      orderBy = undefined;
    }
    if (top !== undefined) {
      drop('$top');
      top = undefined;
    }
    if (skip !== undefined) {
      drop('$skip');
      skip = undefined;
    }
    if (count === true) {
      drop('$count');
      count = undefined;
    }
  }
  if (omitted.length > 0) {
    warnings.push(
      `Note: ${item.qualifiedName ?? item.name} returns ${item.returnType ?? 'an unknown type'}, which ${
        structured ? 'is a single value' : 'is not an entity or complex type'
      }; ${omitted.join(', ')} ${
        omitted.length === 1 ? 'is' : 'are'
      } not applicable and ${omitted.length === 1 ? 'was' : 'were'} omitted.`,
    );
  }

  const hasOptions =
    (select?.length ?? 0) > 0 ||
    (expand?.length ?? 0) > 0 ||
    (filters?.length ?? 0) > 0 ||
    orderBy !== undefined ||
    top !== undefined ||
    skip !== undefined ||
    count === true;
  if (!hasOptions) return '';

  return buildQueryOptions({
    rootEntityName: returnShape.structuredName,
    metadata,
    select,
    expand,
    filters,
    filterLogic,
    orderBy,
    top,
    skip,
    count,
    onWarning: (message) => warnings.push(message),
  });
}

function buildBody(
  item: ODataAction | ODataFunction,
  parameters: Record<string, unknown>,
  metadata: ODataMetadata,
  ieee754Compatible: boolean,
): { body: Record<string, unknown>; contentType: string } {
  const build = (
    stringEncodeAll: boolean,
  ): { body: Record<string, unknown>; encoding: BodyEncoding } => {
    const encoding: BodyEncoding = {
      ieee754Compatible,
      stringEncodeAll,
      stringEncodesIeee754: false,
      complexDepth: 0,
    };
    const body: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(parameters)) {
      const type = declaredParameterType(item, name);
      body[name] = type ? coerceBodyValue(type, value, metadata, encoding, item.namespace) : value;
    }
    return { body, encoding };
  };

  const plain = build(false);
  if (!plain.encoding.stringEncodesIeee754) {
    // Nothing needed the string form, so the body keeps bare JSON numbers and
    // the plain media type.
    return { body: plain.body, contentType: 'application/json' };
  }
  // §4.1 "Header Content-Type": requests MUST include the IEEE754Compatible
  // parameter if Edm.Int64 and Edm.Decimal numbers are represented as strings.
  // Rebuild with the body-wide string form (§3.2), so the declared parameter
  // covers every Int64/Decimal value, not only the inexact one that forced it.
  return {
    body: build(true).body,
    contentType: 'application/json;IEEE754Compatible=true',
  };
}
