import type {
  ODataAction,
  ODataEntity,
  ODataEntitySet,
  ODataFunction,
  ODataMetadata,
  ODataParameter,
  ODataRelationship,
} from '@odata-visualizer/shared';
import {
  buildQueryUrl,
  findEntitiesByName,
  findEntityByName,
  findEntitySet,
  formatV4Literal,
  getAllEntitySets,
  getEffectiveKeys,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
  resolveInheritanceChain,
  suggestNames,
  type ExpandNode,
  type FilterClause,
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
}

const DEFAULT_LIMIT = 50;

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function noMetadata(): ToolResult {
  return errorResult('No metadata loaded. Call load_metadata first with a file path or URL.');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function paginate<T>(items: T[], args: Record<string, unknown>): { slice: T[]; note: string } {
  const limit = asNumber(args['limit']) ?? DEFAULT_LIMIT;
  const offset = asNumber(args['offset']) ?? 0;
  const slice = items.slice(offset, offset + limit);
  const shownEnd = Math.min(offset + limit, items.length);
  const note =
    items.length > slice.length
      ? `\n\nShowing ${offset + 1}-${shownEnd} of ${items.length}. Use limit/offset for more.`
      : `\n\nShowing all ${items.length}.`;
  return { slice, note };
}

function formatEntitySummary(entity: ODataEntity, metadata: ODataMetadata): string {
  const keys = getEffectiveKeys(entity, metadata.entities);
  const keyStr = keys.length > 0 ? ` (keys: ${keys.join(', ')})` : '';
  const kind = entity.kind === 'complex' ? ' [complex]' : '';
  const abstract = entity.abstract ? ' [abstract]' : '';
  const base = entity.baseType ? ` : ${entity.baseType}` : '';
  return `${entity.qualifiedName ?? entity.name}${kind}${abstract}${base}${keyStr} - ${entity.properties.length} props, ${entity.navigationProperties.length} navs`;
}

function formatRelationship(rel: ODataRelationship): string {
  return `${rel.name}: ${rel.from.entity} (${rel.from.multiplicity}) <-> ${rel.to.entity} (${rel.to.multiplicity})`;
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

  const exact = matches.find(
    (e) => (e.qualifiedName ?? e.name).toLowerCase() === name.toLowerCase(),
  );
  if (exact) return { entity: exact };

  return {
    error: errorResult(
      `"${name}" is ambiguous. Use a qualified name: ${matches
        .map((e) => e.qualifiedName ?? e.name)
        .join(', ')}`,
    ),
  };
}

function describeType(type: string, metadata: ODataMetadata): string {
  if (type.startsWith('Edm.')) return type;
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
  const ret = item.returnType ? ` -> ${item.returnType}` : '';
  return `${item.qualifiedName ?? item.name}${bound}${ret}${item.label ? ` - ${item.label}` : ''}`;
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
    const bindingType = item.parameters[0]?.type ?? 'Entity';
    const set = getAllEntitySets(metadata).find(
      (s) =>
        s.entityType === shortName(bindingType) ||
        s.entityTypeQualified === shortName(bindingType) ||
        s.entityType === bindingType,
    );
    const setPath = set?.name ?? '<EntitySet>';
    const keyProp = set
      ? getEffectiveKeys(findEntityByName(metadata.entities, set.entityType)!, metadata.entities)[0]
      : 'ID';
    const keyLiteral = keyProp ? `${keyProp}=<${keyProp}>` : '<key>';
    const root = baseUrl ? baseUrl.replace(/\/+$/, '') : '<serviceRoot>';
    lines.push(`  ${root}/${setPath}(${keyLiteral})/${item.qualifiedName ?? item.name}`);
  } else {
    const root = baseUrl ? baseUrl.replace(/\/+$/, '') : '<serviceRoot>';
    lines.push(`  ${root}/${importName ?? item.name}`);
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
  const collection = /^Collection\((.*)\)$/.exec(type);
  if (collection) return [sampleScalar(collection[1], metadata)];
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
    return `(${formatV4Literal(keys[name], type)})`;
  }
  return `(${keyNames
    .map((name) => {
      const type = properties.find((p) => p.name === name)?.type;
      return `${name}=${formatV4Literal(keys[name], type)}`;
    })
    .join(',')})`;
}

function coerceBodyValue(type: string, value: unknown, metadata: ODataMetadata): unknown {
  const collection = /^Collection\((.*)\)$/.exec(type);
  if (collection) {
    const inner = collection[1];
    const items = Array.isArray(value) ? value : [value];
    return items.map((v) => coerceScalar(inner, v, metadata));
  }
  return coerceScalar(type, value, metadata);
}

function coerceScalar(type: string, value: unknown, metadata: ODataMetadata): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'Edm.Boolean') {
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
  }
  if (
    type === 'Edm.Int16' ||
    type === 'Edm.Int32' ||
    type === 'Edm.Int64' ||
    type === 'Edm.Decimal' ||
    type === 'Edm.Double' ||
    type === 'Edm.Single' ||
    type === 'Edm.Byte' ||
    type === 'Edm.SByte'
  ) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  const typeDef = metadata.typeDefinitions.find((t) => t.qualifiedName === type || t.name === type);
  if (typeDef) return coerceScalar(typeDef.underlyingType, value, metadata);
  return value;
}

function declaredParameterType(
  item: ODataAction | ODataFunction,
  name: string,
): string | undefined {
  return item.parameters?.find((p) => p.name === name)?.type;
}

function formatFunctionParamLiteral(type: string, value: unknown): string {
  const collection = /^Collection\((.*)\)$/.exec(type);
  if (collection) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((v) => formatV4Literal(String(v), collection[1])).join(',');
  }
  return formatV4Literal(String(value), type);
}

export function createToolHandler(
  accessors: MetadataAccessors,
  options: ToolHandlerOptions = {},
): ToolHandler {
  const allowLoadMetadata = options.allowLoadMetadata ?? true;

  return async (name, args) => {
    const currentMetadata = accessors.get()?.metadata ?? null;

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
            'No metadata loaded. Upload a file in the OData Visualizer UI or call load_metadata.',
          );
        }
        const { metadata, info } = stored;
        return textResult(
          [
            'Metadata loaded:',
            `  Source: ${info.sourceName ?? 'unknown'} (${info.sourceType ?? 'unknown'})`,
            `  Loaded: ${info.loadedAt}`,
            `  Entities: ${metadata.entities.length}`,
            `  Entity sets: ${getAllEntitySets(metadata).length}`,
            `  Actions: ${metadata.actions.length}`,
            `  Functions: ${metadata.functions.length}`,
            `  Enums: ${metadata.enumTypes.length}`,
            `  Relationships: ${metadata.relationships.length}`,
          ].join('\n'),
        );
      }

      case 'search_entities': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const query = (asString(args['query']) ?? '').toLowerCase();
        if (!query) return errorResult('Error: query is required');
        const limit = asNumber(args['limit']) ?? 20;

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
            else if (entity.properties.some((p) => p.name.toLowerCase().includes(query))) score = 3;
            else if (
              Object.values(entity.annotations ?? {}).some((v) => v.toLowerCase().includes(query))
            )
              score = 4;
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
            `No entities matching "${args['query']}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
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
          const needle = entityName.toLowerCase();
          rels = rels.filter(
            (r) => r.from.entity.toLowerCase() === needle || r.to.entity.toLowerCase() === needle,
          );
        }

        if (rels.length === 0) {
          return textResult(
            entityName
              ? `No relationships found for "${entityName}".`
              : 'No relationships found in the metadata.',
          );
        }

        const { slice, note } = paginate(rels, args);
        return textResult(`Relationships:\n\n${slice.map(formatRelationship).join('\n')}${note}`);
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

        const action = findCallable(metadata.actions, actionName);
        if (!action) {
          const suggestions = suggestNames(
            actionName,
            metadata.actions.map((a) => a.name),
          );
          return errorResult(
            `Action "${actionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }
        const importName = metadata.actionImports.find(
          (i) => i.qualifiedActionName === action.qualifiedName || i.actionName === action.name,
        )?.name;
        return textResult(
          formatCallableDetails(action, metadata, importName, asString(args['baseUrl']), false),
        );
      }

      case 'get_function_details': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const functionName = asString(args['name']);
        if (!functionName) return errorResult('Error: name is required');

        const func = findCallable(metadata.functions, functionName);
        if (!func) {
          const suggestions = suggestNames(
            functionName,
            metadata.functions.map((f) => f.name),
          );
          return errorResult(
            `Function "${functionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }
        const importName = metadata.functionImports.find(
          (i) => i.qualifiedFunctionName === func.qualifiedName || i.functionName === func.name,
        )?.name;
        return textResult(
          formatCallableDetails(func, metadata, importName, asString(args['baseUrl']), true),
        );
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

        try {
          const url = buildQueryUrl({
            entitySet,
            baseUrl: asString(args['baseUrl']),
            filters: args['filters'] as FilterClause[] | undefined,
            filterLogic: args['filterLogic'] as 'and' | 'or' | undefined,
            select: args['select'] as string[] | undefined,
            expand: args['expand'] as ExpandNode[] | undefined,
            orderBy: asString(args['orderBy']),
            top: asNumber(args['top']),
            skip: asNumber(args['skip']),
            count: typeof args['count'] === 'boolean' ? (args['count'] as boolean) : undefined,
            search: asString(args['search']),
            metadata,
          });

          const warnings: string[] = [];
          if (!findEntitySet(metadata, entitySet)) {
            const suggestions = suggestNames(
              entitySet,
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

        const action = findCallable(metadata.actions, actionName);
        if (!action) {
          const suggestions = suggestNames(
            actionName,
            metadata.actions.map((a) => a.name),
          );
          return errorResult(
            `Action "${actionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }

        return buildInvocation('POST', action, metadata, args, false);
      }

      case 'build_function_invocation': {
        if (!currentMetadata) return noMetadata();
        const metadata = currentMetadata;
        const functionName = asString(args['functionName']);
        if (!functionName) return errorResult('Error: functionName is required');

        const func = findCallable(metadata.functions, functionName);
        if (!func) {
          const suggestions = suggestNames(
            functionName,
            metadata.functions.map((f) => f.name),
          );
          return errorResult(
            `Function "${functionName}" not found.${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
          );
        }

        return buildInvocation('GET', func, metadata, args, true);
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  };
}

const defaultHandler = createToolHandler(defaultStore);

export const handleToolCall: ToolHandler = (name, args) => defaultHandler(name, args);

function findCallable<T extends ODataAction | ODataFunction>(
  items: T[],
  name: string,
): T | undefined {
  const needle = name.toLowerCase();
  const exact = items.find(
    (i) => (i.qualifiedName ?? '').toLowerCase() === needle || i.name.toLowerCase() === needle,
  );
  return exact ?? items.find((i) => i.name.toLowerCase() === shortName(name).toLowerCase());
}

function buildInvocation(
  method: 'GET' | 'POST',
  item: ODataAction | ODataFunction,
  metadata: ODataMetadata,
  args: Record<string, unknown>,
  isFunction: boolean,
): ToolResult {
  const entitySetName = asString(args['entitySet']);
  const keys = (args['keys'] as Record<string, string> | undefined) ?? {};
  const parameters = (args['parameters'] as Record<string, unknown> | undefined) ?? {};
  const baseUrl = asString(args['baseUrl']);
  const root = (baseUrl ?? '<serviceRoot>').replace(/\/+$/, '');

  let path: string;
  if (item.isBound) {
    if (!entitySetName) {
      return errorResult(
        `Error: "${item.name}" is bound; entitySet and keys are required to form the resource path.`,
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
    path = `${set.name}${keySegment}/${item.qualifiedName ?? item.name}`;
  } else {
    const importName = isFunction
      ? metadata.functionImports.find(
          (i) => i.qualifiedFunctionName === item.qualifiedName || i.functionName === item.name,
        )?.name
      : metadata.actionImports.find(
          (i) => i.qualifiedActionName === item.qualifiedName || i.actionName === item.name,
        )?.name;
    path = importName ?? item.name;
  }

  const inline = isFunction ? formatInlineParams(item, parameters) : '';
  const fullPath = `${path}${inline}`;

  const lines: string[] = [];
  lines.push(`${method} ${root}/${fullPath}`);
  lines.push('Content-Type: application/json');

  if (isFunction) {
    lines.push('');
    lines.push('Parameters: inline in the URL (see above).');
    return textResult(lines.join('\n'));
  }

  const body = buildBody(item, parameters, metadata);
  lines.push('');
  lines.push('Body:');
  lines.push(JSON.stringify(body, null, 2));
  lines.push('');
  lines.push('Example:');
  lines.push(
    [
      `curl -X ${method}`,
      `  '${root}/${fullPath}'`,
      "  -H 'Content-Type: application/json'",
      `  -d '${JSON.stringify(body)}'`,
    ].join(' \\\n'),
  );

  return textResult(lines.join('\n'));
}

function formatInlineParams(
  item: ODataAction | ODataFunction,
  parameters: Record<string, unknown>,
): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) return '';
  const rendered = entries.map(([name, value]) => {
    const type = declaredParameterType(item, name);
    return `${name}=${type ? formatFunctionParamLiteral(type, value) : formatV4Literal(String(value))}`;
  });
  return `(${rendered.join(',')})`;
}

function buildBody(
  item: ODataAction | ODataFunction,
  parameters: Record<string, unknown>,
  metadata: ODataMetadata,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parameters)) {
    const type = declaredParameterType(item, name);
    body[name] = type ? coerceBodyValue(type, value, metadata) : value;
  }
  return body;
}
