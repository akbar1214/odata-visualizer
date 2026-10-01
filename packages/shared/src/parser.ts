import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import { resolveInheritanceChain, findEntityByName, findEntitySet } from './resolve.js';
import type {
  ODataMetadata,
  ODataEntity,
  ODataProperty,
  ODataRelationship,
  ODataAssociationEnd,
  ODataNavigationProperty,
  ODataNavigationPropertyBinding,
  ODataFunctionImport,
  ODataFunction,
  ODataActionImport,
  ODataAction,
  ODataEntityContainer,
  ODataEntitySet,
  ODataParameter,
  ODataEnumType,
  ODataEnumMember,
  ODataTypeDefinition,
} from './types.js';

type XmlElement = Record<string, unknown>;

const XML_PARSER_OPTIONS: X2jOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: true,
  // Keep attribute values as raw strings so Version="4.0" and
  // MaxLength="Max" survive intact (post-processing coerces as needed).
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name: string) => {
    return [
      'Schema',
      'EntityType',
      'ComplexType',
      'Property',
      'NavigationProperty',
      'Association',
      'End',
      'Key',
      'PropertyRef',
      'EntityContainer',
      'EntitySet',
      'Function',
      'FunctionImport',
      'Action',
      'ActionImport',
      'Parameter',
      'ReturnType',
      'EnumType',
      'Member',
      'TypeDefinition',
      'Annotation',
      'NavigationPropertyBinding',
    ].includes(name);
  },
};

const parser = new XMLParser(XML_PARSER_OPTIONS);

const MEMBER_VALUE_ATTRS = ['@_Value', '@_value'] as const;
const ANNOTATION_SCALAR_ATTRS = [
  '@_String',
  '@_Bool',
  '@_EnumMember',
  '@_Int',
  '@_Decimal',
  '@_Float',
  '@_Guid',
  '@_DateTimeOffset',
  '@_Date',
  '@_Duration',
  '@_TimeOfDay',
] as const;
const ANNOTATION_SCALAR_CHILDREN = [
  'String',
  'Bool',
  'EnumMember',
  'Int',
  'Decimal',
  'Float',
  'Guid',
  'DateTimeOffset',
  'Date',
  'Duration',
  'TimeOfDay',
] as const;

export interface ParseOptions {
  /** Absolute base URI used to resolve relative `edmx:Reference/@Uri` values. */
  baseUri?: string;
  /** Loads an external document referenced by `edmx:Reference/@Uri`. */
  loadExternal?: (uri: string) => Promise<string>;
  /** Safety valve against pathological reference graphs (default 25). */
  maxExternalDocuments?: number;
}

interface EdmxDocument {
  schemas: XmlElement[];
  references: XmlElement[];
  version?: string;
  dataServicesVersion?: string;
}

/**
 * References declared directly on an element, under both valid spellings.
 *
 * The previous `owner['Reference'] || owner['edmx:Reference']` returned only the
 * first, so an element carrying both lost a group. XML allows both in one
 * parent, and `isArray` does not list `Reference`, so single values arrive as
 * objects and repeats as arrays — `ensureArray` normalises both.
 */
function referenceElements(owner: XmlElement): XmlElement[] {
  return [...ensureArray(owner['Reference']), ...ensureArray(owner['edmx:Reference'])];
}

function parseEdmxDocument(xmlContent: string): EdmxDocument {
  let parsed: XmlElement;
  try {
    parsed = parser.parse(xmlContent) as XmlElement;
  } catch (error) {
    throw new Error(
      `Failed to parse XML: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  if (!parsed) {
    throw new Error('Parsed XML is empty');
  }

  const edmx = (parsed['edmx:Edmx'] || parsed['Edmx']) as XmlElement | undefined;
  if (!edmx) {
    throw new Error('Invalid OData CSDL: Missing Edmx root element');
  }

  const dataServices = (edmx['edmx:DataServices'] || edmx['DataServices']) as
    XmlElement | undefined;
  if (!dataServices) {
    throw new Error('Invalid OData CSDL: Missing DataServices element');
  }

  const schemas = ensureArray(dataServices['Schema'] || dataServices['edm:Schema'] || []);
  // Per CSDL, `edmx:Reference` is a child of `edmx:Edmx`. It is also accepted
  // inside `DataServices` (and on a `Schema`), which is where this used to look
  // only — so a reference in its standard position was ignored entirely.
  const references = [
    ...referenceElements(edmx),
    ...referenceElements(dataServices),
    ...schemas.flatMap((s) => referenceElements(s)),
  ];

  return {
    schemas,
    references,
    version: str(edmx['@_Version']) || undefined,
    dataServicesVersion:
      str(dataServices['@_m:DataServiceVersion']) ||
      str(dataServices['@_DataServiceVersion']) ||
      undefined,
  };
}

/** Resolve a possibly relative reference URI against the document's base URI. */
function resolveReferenceUri(uri: string, baseUri: string | undefined): string {
  try {
    return baseUri ? new URL(uri, baseUri).toString() : new URL(uri).toString();
  } catch {
    return uri;
  }
}

/**
 * Replace an `Alias.Type` reference with `Namespace.Type` using the aliases
 * declared by edmx:Include elements.
 *
 * A prefix that names an actual schema is treated as a namespace, not an alias.
 * An alias is only valid within the document that declares it (CSDL 4.01 §4.2),
 * so a document-local alias must never rewrite a reference into a *different*
 * document's namespace — which is what a single document-global alias map would
 * otherwise do.
 */
function expandAlias(type: string, aliases: Map<string, string>, namespaces?: Set<string>): string {
  const collection = /^Collection\((.*)\)$/.exec(type);
  if (collection) return `Collection(${expandAlias(collection[1], aliases, namespaces)})`;
  if (type.startsWith('Edm.')) return type;

  const dot = type.indexOf('.');
  if (dot <= 0) return type;

  const prefix = type.slice(0, dot);
  if (namespaces?.has(prefix.toLowerCase())) return type;

  const namespace = aliases.get(prefix);
  return namespace ? `${namespace}${type.slice(dot)}` : type;
}

function expandAliasesInMetadata(
  metadata: ODataMetadata,
  aliases: Map<string, string>,
  namespaces: Set<string>,
): void {
  if (aliases.size === 0) return;

  const expand = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : expandAlias(value, aliases, namespaces);

  for (const entity of metadata.entities) {
    entity.baseType = expand(entity.baseType);
    for (const prop of entity.properties) {
      prop.type = expand(prop.type) ?? prop.type;
    }
    for (const nav of entity.navigationProperties) {
      nav.targetTypeQualified = expand(nav.targetTypeQualified);
      nav.targetType = nav.targetTypeQualified
        ? shortName(nav.targetTypeQualified)
        : expand(nav.targetType);
      // V2 stores the association name here, and a namespaced generator writes
      // `Self.R1`. Leaving it alias-qualified made the navigation property
      // disagree with every other type reference in the same document.
      // A V4 value is `'Collection'` or `''`, neither of which has a dot, so
      // expansion is a no-op for them.
      // Idempotent with the derivation-time expansion above: an already
      // expanded value has a known-namespace prefix, so this is a no-op. The
      // `??` is a type-level assertion, not a fallback — `expand` returns
      // `undefined` only for `undefined` input, which the guard excludes.
      if (nav.relationship) nav.relationship = expand(nav.relationship) ?? nav.relationship;
    }
  }

  // Relationship endpoints carry their own copy of the type reference. Leaving
  // them unexpanded made a relationship disagree with the navigation property
  // it was derived from, and `layout.ts` prefers `entityQualified`, so the
  // diagram could not match the edge to a node.
  for (const relationship of metadata.relationships) {
    relationship.from.entityQualified = expand(relationship.from.entityQualified);
    relationship.to.entityQualified = expand(relationship.to.entityQualified);
  }

  for (const container of metadata.entityContainers) {
    for (const set of container.entitySets) {
      set.entityTypeQualified = expand(set.entityTypeQualified);
      set.entityType = set.entityTypeQualified
        ? shortName(set.entityTypeQualified)
        : set.entityType;
      for (const binding of set.navigationPropertyBindings ?? []) {
        binding.target = expand(binding.target) ?? binding.target;
      }
    }
  }
  for (const item of [...metadata.actions, ...metadata.functions]) {
    item.returnType = expand(item.returnType);
    for (const param of item.parameters) {
      param.type = expand(param.type) ?? param.type;
    }
  }
  for (const typeDefinition of metadata.typeDefinitions) {
    typeDefinition.underlyingType =
      expand(typeDefinition.underlyingType) ?? typeDefinition.underlyingType;
  }
  for (const enumType of metadata.enumTypes) {
    if (enumType.underlyingType) {
      enumType.underlyingType = expand(enumType.underlyingType);
    }
  }
  for (const importRecord of metadata.actionImports) {
    if (importRecord.qualifiedActionName) {
      importRecord.qualifiedActionName = expand(importRecord.qualifiedActionName);
    }
    // The import snapshots the definition's return type during parsing, before
    // aliases are known, so it has to be expanded too or it stays stale.
    importRecord.returnType = expand(importRecord.returnType);
    for (const param of importRecord.parameter ?? []) {
      param.type = expand(param.type) ?? param.type;
    }
  }
  for (const importRecord of metadata.functionImports) {
    if (importRecord.qualifiedFunctionName) {
      importRecord.qualifiedFunctionName = expand(importRecord.qualifiedFunctionName);
    }
    importRecord.returnType = expand(importRecord.returnType);
    for (const param of importRecord.parameter ?? []) {
      param.type = expand(param.type) ?? param.type;
    }
  }
}

/**
 * Parse OData CSDL XML content into structured metadata.
 *
 * Schemas pulled in through `edmx:Include` / `edmx:Reference` are merged in.
 * External documents are only fetched when `loadExternal` is supplied; a
 * reference that cannot be loaded is reported in `unresolvedReferences`
 * instead of failing the whole parse.
 */
export async function parseCSDL(
  xmlContent: string,
  options: ParseOptions = {},
): Promise<ODataMetadata> {
  if (!xmlContent || xmlContent.trim().length === 0) {
    throw new Error('XML content is empty');
  }

  const rootDocument = parseEdmxDocument(xmlContent);
  const version = rootDocument.version;
  const dataServicesVersion = rootDocument.dataServicesVersion;

  const entities: ODataEntity[] = [];
  const relationships: ODataRelationship[] = [];
  const functionImports: ODataFunctionImport[] = [];
  const actionImports: ODataActionImport[] = [];
  const entityContainers: ODataEntityContainer[] = [];
  const actions: ODataAction[] = [];
  const functions: ODataFunction[] = [];
  const enumTypes: ODataEnumType[] = [];
  const typeDefinitions: ODataTypeDefinition[] = [];
  const unresolvedReferences: string[] = [];
  /**
   * `<Annotations Target="...">` blocks, collected per schema and applied once
   * the whole model is parsed. CSDL places most annotations here rather than
   * inline, and `parseAnnotations` reads only direct `<Annotation>` children,
   * so these were dropped entirely.
   */
  const targetedAnnotations: Array<{ target: string; annotations: Record<string, string> }> = [];

  const registry = new Map<string, XmlElement>();
  const aliases = new Map<string, string>();
  const queue: XmlElement[] = [];
  const visitedUris = new Set<string>();
  const maxExternalDocuments = options.maxExternalDocuments ?? 25;
  let externalDocumentsLoaded = 0;

  // All three spellings are valid, and XML allows them to coexist in one
  // parent — `a || b || c` returned only the first, so a reference carrying
  // both `<Include>` and `<edmx:Include>` silently lost a group of alias
  // declarations. Same defect class as the `<Reference>` fix.
  const includesOf = (owner: XmlElement): XmlElement[] => [
    ...ensureArray(owner['Include']),
    ...ensureArray(owner['edmx:Include']),
    ...ensureArray(owner['edm:Include']),
  ];

  const registerSchema = (schema: XmlElement): void => {
    const namespace = str(schema['@_Namespace']);
    if (!namespace || registry.has(namespace)) return;
    registry.set(namespace, schema);
    queue.push(schema);
  };

  const registerAliases = (owner: XmlElement): void => {
    // A schema may alias its own namespace — `<Schema Namespace="N" Alias="Self">`
    // — and every generator that writes `Self.Type` references relies on it.
    // Reading only `Include` here left those references unexpanded, so
    // `BaseType="Self.Base"` produced no inheritance chain and `getEffectiveKeys`
    // returned nothing.
    const ownerNamespace = str(owner['@_Namespace']);
    const ownerAlias = str(owner['@_Alias']);
    if (ownerNamespace && ownerAlias && !aliases.has(ownerAlias)) {
      aliases.set(ownerAlias, ownerNamespace);
    }

    for (const include of includesOf(owner)) {
      const namespace = str(include['@_Namespace']);
      const alias = str(include['@_Alias']);
      if (namespace && alias && !aliases.has(alias)) {
        aliases.set(alias, namespace);
      }
    }
  };

  for (const schema of rootDocument.schemas) {
    registerSchema(schema);
    registerAliases(schema);
  }
  for (const reference of rootDocument.references) {
    registerAliases(reference);
  }

  const loadReferences = async (references: XmlElement[]): Promise<void> => {
    for (const reference of references) {
      const uri = str(reference['@_Uri']);
      if (!uri) continue;

      if (!options.loadExternal) {
        if (!unresolvedReferences.includes(uri)) unresolvedReferences.push(uri);
        continue;
      }

      const absoluteUri = resolveReferenceUri(uri, options.baseUri);
      if (visitedUris.has(absoluteUri)) continue;

      if (externalDocumentsLoaded >= maxExternalDocuments) {
        if (!unresolvedReferences.includes(uri)) unresolvedReferences.push(uri);
        continue;
      }

      visitedUris.add(absoluteUri);
      externalDocumentsLoaded += 1;
      try {
        const externalDocument = parseEdmxDocument(await options.loadExternal(absoluteUri));
        for (const schema of externalDocument.schemas) {
          registerSchema(schema);
          registerAliases(schema);
        }
        // Includes on the reference describe aliases the including document uses.
        registerAliases(reference);
        await loadReferences(externalDocument.references);
      } catch {
        if (!unresolvedReferences.includes(uri)) unresolvedReferences.push(uri);
      }
    }
  };

  await loadReferences(rootDocument.references);

  // Aliases and the namespace registry are complete by now (`loadReferences`
  // above loads every external document), so relationship derivation can expand
  // association names immediately instead of leaving a stale copy behind.
  const knownNamespaces = new Set([...registry.keys()].map((ns) => ns.toLowerCase()));
  const expandReference = (value: string): string => expandAlias(value, aliases, knownNamespaces);

  while (queue.length > 0) {
    const schema = queue.shift() as XmlElement;
    const namespace = str(schema['@_Namespace']) || '';
    const entityTypeNames = new Set<string>();

    const entityTypes = ensureArray(schema['EntityType'] || schema['edm:EntityType'] || []);
    for (const entityType of entityTypes) {
      const entity = parseEntityType(entityType, namespace);
      if (entity.name) {
        entityTypeNames.add(entity.name);
        entities.push(entity);
      }
    }

    const complexTypes = ensureArray(schema['ComplexType'] || schema['edm:ComplexType'] || []);
    for (const complexType of complexTypes) {
      const complex = parseComplexType(complexType, namespace);
      if (complex.name) {
        entities.push(complex);
      }
    }

    const associations = ensureArray(schema['Association'] || schema['edm:Association'] || []);
    for (const association of associations) {
      const rel = parseAssociation(association, namespace);
      if (rel) {
        relationships.push(rel);
      }
    }

    const enumElements = ensureArray(schema['EnumType'] || schema['edm:EnumType'] || []);
    for (const enumEl of enumElements) {
      const parsedEnum = parseEnumType(enumEl, namespace);
      if (parsedEnum) {
        enumTypes.push(parsedEnum);
      }
    }

    const typeDefElements = ensureArray(
      schema['TypeDefinition'] || schema['edm:TypeDefinition'] || [],
    );
    for (const typeDefEl of typeDefElements) {
      const parsedTypeDef = parseTypeDefinition(typeDefEl, namespace);
      if (parsedTypeDef) {
        typeDefinitions.push(parsedTypeDef);
      }
    }

    const actionDefs = new Map<string, ODataAction>();
    const actionElements = ensureArray(schema['Action'] || schema['edm:Action'] || []);
    for (const actionEl of actionElements) {
      const action = parseAction(actionEl, namespace);
      if (action.name && !actionDefs.has(action.name)) {
        actionDefs.set(action.name, action);
      }
      if (action.name) {
        actions.push(action);
      }
    }

    const functionDefs = new Map<string, ODataFunction>();
    const functionElements = ensureArray(schema['Function'] || schema['edm:Function'] || []);
    for (const funcEl of functionElements) {
      const func = parseFunction(funcEl, namespace);
      if (func.name && !functionDefs.has(func.name)) {
        functionDefs.set(func.name, func);
      }
      if (func.name) {
        functions.push(func);
      }
    }

    const containers = ensureArray(
      schema['EntityContainer'] || schema['edm:EntityContainer'] || [],
    );
    for (const container of containers) {
      const containerName = str(container['@_Name']) || '';
      const entitySets = ensureArray(container['EntitySet'] || container['edm:EntitySet'] || []);
      const parsedEntitySets: ODataEntitySet[] = [];
      for (const entitySet of entitySets) {
        const es = parseEntitySet(entitySet);
        if (es) {
          parsedEntitySets.push(es);
        }
      }
      if (containerName || parsedEntitySets.length > 0) {
        entityContainers.push({ name: containerName, namespace, entitySets: parsedEntitySets });
      }

      const funcImports = ensureArray(
        container['FunctionImport'] || container['edm:FunctionImport'] || [],
      );
      for (const funcImport of funcImports) {
        const fi = parseFunctionImport(funcImport, functionDefs);
        if (fi) {
          functionImports.push(fi);
        }
      }

      const actImports = ensureArray(
        container['ActionImport'] || container['edm:ActionImport'] || [],
      );
      for (const actionImport of actImports) {
        const ai = parseActionImport(actionImport, actionDefs);
        if (ai) {
          actionImports.push(ai);
        }
      }
    }

    // V4 metadata has no Association elements; derive relationships from
    // navigation properties with a Type/Target (targetType) attribute.
    for (const entity of entities) {
      if (entity.namespace !== namespace || !entityTypeNames.has(entity.name)) {
        continue;
      }
      for (const nav of entity.navigationProperties) {
        if (!nav.targetType) continue;
        const rel = relationshipFromNavigationProperty(entity, nav, namespace, expandReference);
        if (!rel) continue;
        if (!relationships.some((r) => isSameDerivedRelationship(r, rel))) {
          relationships.push(rel);
        }
      }
    }

    // Schema-level annotations, applied after the model is complete so a target
    // may name anything in any schema.
    for (const annotationsEl of ensureArray(
      schema['Annotations'] || schema['edm:Annotations'] || [],
    )) {
      const target = str(annotationsEl['@_Target']);
      if (!target) continue;
      const annotations = parseAnnotations(annotationsEl);
      if (annotations) targetedAnnotations.push({ target, annotations });
    }
  }

  const metadata: ODataMetadata = {
    version,
    dataServicesVersion,
    entities,
    relationships,
    entityContainers,
    functionImports,
    actionImports,
    actions,
    functions,
    enumTypes,
    typeDefinitions,
  };

  expandAliasesInMetadata(metadata, aliases, knownNamespaces);

  applyTargetedAnnotations(
    metadata,
    targetedAnnotations,
    aliases,
    new Set([...registry.keys()].map((ns) => ns.toLowerCase())),
  );

  // Derived types often omit <Key> (it is inherited). Backfill keys from
  // the base-type chain so consumers (and the complex-type heuristic) work.
  for (const entity of entities) {
    if (entity.kind === 'complex' || entity.keys.length > 0 || !entity.baseType) continue;
    const chain = resolveInheritanceChain(entity, entities);
    for (const base of chain.slice(1)) {
      if (base.keys.length > 0) {
        entity.keys = [...base.keys];
        const keySet = new Set(base.keys);
        for (const prop of entity.properties) {
          if (keySet.has(prop.name)) prop.isKey = true;
        }
        break;
      }
    }
  }

  if (unresolvedReferences.length > 0) {
    metadata.unresolvedReferences = unresolvedReferences;
  }

  return metadata;
}

/**
 * Two derived relationships are the same when they are either an exact
 * duplicate, or the two halves of one bidirectional navigation property
 * (`Order.Customer` and `Customer.Orders`). Distinct same-direction
 * navigation properties between the same pair of types stay separate.
 */
function isSameDerivedRelationship(a: ODataRelationship, b: ODataRelationship): boolean {
  const sameDirection =
    a.from.entity === b.from.entity && a.to.entity === b.to.entity && a.name === b.name;
  if (sameDirection) return true;

  return (
    a.from.entity === b.to.entity &&
    a.to.entity === b.from.entity &&
    a.from.multiplicity === b.to.multiplicity &&
    a.to.multiplicity === b.from.multiplicity
  );
}

function relationshipFromNavigationProperty(
  entity: ODataEntity,
  nav: ODataNavigationProperty,
  namespace: string,
  expand: (value: string) => string,
): ODataRelationship | null {
  if (!nav.targetType) return null;
  const isCollection = nav.relationship === 'Collection';
  // Expanded here rather than in the later pass: the relationship is derived
  // during parsing, so expanding only `nav.relationship` afterwards left this
  // copy saying `Self.R1` while the navigation property said `N.R1` — the
  // navigation property disagreeing with the relationship derived from it.
  const associationName =
    nav.relationship && nav.relationship !== 'Collection'
      ? expand(nav.relationship)
      : `${entity.name}_${nav.name}`;
  return {
    name: associationName,
    namespace,
    from: {
      entity: entity.name,
      entityQualified: entity.qualifiedName,
      role: nav.fromRole || entity.name,
      multiplicity: isCollection ? '*' : '1',
    },
    to: {
      entity: nav.targetType,
      // The parser keeps the qualified target (`nav.targetTypeQualified`) but
      // this used to drop it, so consumers could only guess between types that
      // share a short name across namespaces.
      entityQualified: nav.targetTypeQualified,
      role: nav.toRole || nav.targetType,
      multiplicity: isCollection ? '1' : '*',
    },
  };
}

/**
 * Apply `<Annotations Target="...">` blocks to the elements they name.
 *
 * CSDL puts most annotations in these blocks rather than inline on the element:
 * it is the canonical form for annotating a type defined elsewhere, and the
 * only way to annotate one property of a type. `parseAnnotations` reads direct
 * `<Annotation>` children, so every block was dropped.
 *
 * An annotation declared on the element itself wins over a targeted one — the
 * element's own declaration is the more specific statement.
 *
 * Targets that name nothing in the document are ignored rather than reported:
 * an `Annotations` block commonly targets a type from an `edmx:Reference` that
 * could not be loaded, which `unresolvedReferences` already covers.
 */
function applyTargetedAnnotations(
  metadata: ODataMetadata,
  targeted: Array<{ target: string; annotations: Record<string, string> }>,
  aliases: Map<string, string>,
  namespaces: Set<string>,
): void {
  const merge = (
    current: Record<string, string> | undefined,
    extra: Record<string, string>,
  ): Record<string, string> => ({ ...extra, ...current });

  for (const { target, annotations } of targeted) {
    // The namespace guard added in #25 matters here too: a prefix that names an
    // actual schema is a namespace, not an alias, so an annotation target
    // cannot be rewritten into another document's namespace.
    const expanded = expandAlias(target, aliases, namespaces);
    const segments = expanded.split('/');

    // `NS.Type/Prop`. Per CSDL a schema child must be namespace-qualified, so
    // an unqualified first segment cannot be a type — requiring the dot keeps
    // `C/Widgets` from matching a property named `Widgets` on some type `C`.
    if (segments.length === 2 && segments[0].includes('.')) {
      const owner = findEntityByName(metadata.entities, segments[0]);
      if (owner) {
        // Annotations apply to structural *or* navigation properties.
        const property =
          owner.properties.find((p) => p.name === segments[1]) ??
          owner.navigationProperties.find((p) => p.name === segments[1]);
        if (property) {
          property.annotations = merge(property.annotations, annotations);
          property.label = labelFromAnnotations(property.annotations) ?? property.label;
          continue;
        }
      }
    }

    // `NS.Container/Set` — the spec form, and what `odata-demo-metadata.xml`
    // uses (`ODataDemo.DemoService/Suppliers`). The unqualified `Container/Set`
    // is accepted too, because it costs nothing and appears in hand-written
    // documents.
    if (segments.length === 2) {
      const container = metadata.entityContainers.find(
        (c) => c.name === segments[0] || `${c.namespace ?? ''}.${c.name}` === segments[0],
      );
      const set = container?.entitySets.find((s) => s.name === segments[1]);
      if (set) {
        set.annotations = merge(set.annotations, annotations);
        set.label = labelFromAnnotations(set.annotations) ?? set.label;
        continue;
      }
    }

    if (segments.length === 1) {
      // A type, or a container-less entity set name.
      const entity = findEntityByName(metadata.entities, expanded);
      if (entity) {
        entity.annotations = merge(entity.annotations, annotations);
        entity.label = labelFromAnnotations(entity.annotations) ?? entity.label;
        continue;
      }
      const set = findEntitySet(metadata, expanded);
      if (set) {
        set.annotations = merge(set.annotations, annotations);
        set.label = labelFromAnnotations(set.annotations) ?? set.label;
      }
    }
  }
}

function parseEntitySet(entitySet: XmlElement): ODataEntitySet | null {
  const name = str(entitySet['@_Name']);
  const rawType = str(entitySet['@_EntityType']);
  if (!name || !rawType) return null;

  const entityType = shortName(rawType);
  const bindings = ensureArray(
    entitySet['NavigationPropertyBinding'] || entitySet['edm:NavigationPropertyBinding'] || [],
  )
    .map(parseNavigationPropertyBinding)
    .filter((b): b is ODataNavigationPropertyBinding => b !== null);

  return {
    name,
    entityType,
    entityTypeQualified: rawType || undefined,
    creatable: boolAttr(entitySet['@_Creatable']),
    updatable: boolAttr(entitySet['@_Updatable']),
    deletable: boolAttr(entitySet['@_Deletable']),
    navigable: boolAttr(entitySet['@_Navigable']),
    navigationPropertyBindings: bindings.length > 0 ? bindings : undefined,
    annotations: parseAnnotations(entitySet),
  };
}

function parseNavigationPropertyBinding(
  binding: XmlElement,
): ODataNavigationPropertyBinding | null {
  const path = str(binding['@_Path']);
  const target = str(binding['@_Target']);
  if (!path || !target) return null;
  return { path, target };
}

function parseActionImport(
  actionImport: XmlElement,
  actionDefs: Map<string, ODataAction>,
): ODataActionImport | null {
  const name = str(actionImport['@_Name']);
  if (!name) return null;

  const rawAction = str(actionImport['@_Action']) || '';
  const actionName = shortName(rawAction);
  const def = actionDefs.get(actionName);
  const entitySet = str(actionImport['@_EntitySet']) || undefined;

  return {
    name,
    actionName,
    qualifiedActionName: def?.qualifiedName || rawAction || undefined,
    entitySet,
    isBound: def?.isBound,
    parameter: def && def.parameters.length > 0 ? def.parameters : undefined,
    returnType: def?.returnType,
    annotations: parseAnnotations(actionImport),
  };
}

function parseAction(el: XmlElement, namespace: string): ODataAction {
  const name = str(el['@_Name']) || '';
  const isBound = str(el['@_IsBound']) === 'true';
  const parameters = parseParameters(el, isBound);
  const returnType = parseReturnType(el);

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    isBound,
    parameters,
    returnType,
    annotations: parseAnnotations(el),
  };
}

function parseFunction(el: XmlElement, namespace: string): ODataFunction {
  const name = str(el['@_Name']) || '';
  const isBound = str(el['@_IsBound']) === 'true';
  const parameters = parseParameters(el, isBound);
  const returnType = parseReturnType(el);

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    isBound,
    parameters,
    returnType,
    annotations: parseAnnotations(el),
  };
}

function parseParameters(el: XmlElement, isBound: boolean): ODataParameter[] {
  const parameters: ODataParameter[] = [];
  const paramElements = ensureArray(el['Parameter'] || el['edm:Parameter'] || []);
  paramElements.forEach((param, index) => {
    const parsed = parseParameter(param);
    if (parsed) {
      if (isBound && index === 0) {
        parsed.isBinding = true;
      }
      parameters.push(parsed);
    }
  });
  return parameters;
}

function parseParameter(param: XmlElement): ODataParameter | null {
  const name = str(param['@_Name']);
  if (!name) return null;
  return {
    name,
    type: str(param['@_Type']) || 'Edm.String',
    nullable: str(param['@_Nullable']) !== 'false',
    maxLength: parseNonNegativeInt(param['@_MaxLength']),
  };
}

function parseReturnType(el: XmlElement): string | undefined {
  const returnTypes = ensureArray(el['ReturnType'] || el['edm:ReturnType'] || []);
  const rt = returnTypes[0];
  if (!rt) return undefined;
  const type = str(rt['@_Type']);
  if (!type) return undefined;
  if (str(rt['@_IsCollection']) === 'true') {
    return type.startsWith('Collection(') ? type : `Collection(${type})`;
  }
  return type;
}

function parseFunctionImport(
  funcImport: XmlElement,
  functionDefs: Map<string, ODataFunction>,
): ODataFunctionImport | null {
  const name = str(funcImport['@_Name']);
  if (!name) return null;

  const functionName = str(funcImport['@_Function']) || '';
  const entitySet = str(funcImport['@_EntitySet']) || undefined;
  const def = functionDefs.get(shortName(functionName));

  const parameters = parseParameters(funcImport, false);
  const returnType = def?.returnType;
  const effectiveParams = parameters.length > 0 ? parameters : def ? def.parameters : [];

  return {
    name,
    functionName: shortName(functionName) || functionName,
    qualifiedFunctionName: def?.qualifiedName || functionName || undefined,
    entitySet,
    parameter: effectiveParams.length > 0 ? effectiveParams : undefined,
    returnType,
    isBound: def?.isBound,
    annotations: parseAnnotations(funcImport),
  };
}

function parseEnumType(el: XmlElement, namespace: string): ODataEnumType | null {
  const name = str(el['@_Name']);
  if (!name) return null;

  const members: ODataEnumMember[] = [];
  for (const memberEl of ensureArray(el['Member'] || el['edm:Member'] || [])) {
    const memberName = str(memberEl['@_Name']);
    if (!memberName) continue;
    let value: string | undefined;
    for (const attr of MEMBER_VALUE_ATTRS) {
      if (memberEl[attr] !== undefined) {
        value = str(memberEl[attr]);
        break;
      }
    }
    members.push({ name: memberName, value });
  }

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    underlyingType: str(el['@_UnderlyingType']) || undefined,
    members,
    annotations: parseAnnotations(el),
  };
}

function parseTypeDefinition(el: XmlElement, namespace: string): ODataTypeDefinition | null {
  const name = str(el['@_Name']);
  const underlyingType = str(el['@_UnderlyingType']);
  if (!name || !underlyingType) return null;

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    underlyingType,
    annotations: parseAnnotations(el),
  };
}

function parseEntityType(entityType: XmlElement, namespace: string): ODataEntity {
  const name = str(entityType['@_Name']) || '';
  const baseType = str(entityType['@_BaseType']) || undefined;
  const isAbstract = str(entityType['@_Abstract']) === 'true';
  const isOpenType = str(entityType['@_OpenType']) === 'true';
  const annotations = parseAnnotations(entityType);

  const keys: string[] = [];
  const properties: ODataProperty[] = [];
  const navigationProperties: ODataNavigationProperty[] = [];

  const keyElements = ensureArray(entityType['Key'] || entityType['edm:Key'] || []);
  for (const key of keyElements) {
    const propertyRefs = ensureArray(key['PropertyRef'] || key['edm:PropertyRef'] || []);
    for (const propRef of propertyRefs) {
      const keyName = str(propRef['@_Name']);
      if (keyName) {
        keys.push(keyName);
      }
    }
  }

  const propElements = ensureArray(entityType['Property'] || entityType['edm:Property'] || []);
  for (const prop of propElements) {
    properties.push(parseProperty(prop, keys));
  }

  const navPropElements = ensureArray(
    entityType['NavigationProperty'] || entityType['edm:NavigationProperty'] || [],
  );
  for (const navProp of navPropElements) {
    navigationProperties.push(parseNavigationProperty(navProp));
  }

  return {
    name,
    qualifiedName: qualify(namespace, name),
    kind: 'entity',
    namespace,
    baseType,
    abstract: isAbstract,
    openType: isOpenType,
    properties,
    navigationProperties,
    keys,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseComplexType(complexType: XmlElement, namespace: string): ODataEntity {
  const name = str(complexType['@_Name']) || '';
  const baseType = str(complexType['@_BaseType']) || undefined;
  const isOpenType = str(complexType['@_OpenType']) === 'true';
  const annotations = parseAnnotations(complexType);

  const properties: ODataProperty[] = [];
  const navigationProperties: ODataNavigationProperty[] = [];

  const propElements = ensureArray(complexType['Property'] || complexType['edm:Property'] || []);
  for (const prop of propElements) {
    properties.push(parseProperty(prop, []));
  }

  const navPropElements = ensureArray(
    complexType['NavigationProperty'] || complexType['edm:NavigationProperty'] || [],
  );
  for (const navProp of navPropElements) {
    navigationProperties.push(parseNavigationProperty(navProp));
  }

  return {
    name,
    qualifiedName: qualify(namespace, name),
    kind: 'complex',
    namespace,
    baseType,
    abstract: false,
    openType: isOpenType,
    properties,
    navigationProperties,
    keys: [],
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseProperty(prop: XmlElement, keys: string[]): ODataProperty {
  const name = str(prop['@_Name']) || '';
  const type = str(prop['@_Type']) || 'Edm.String';
  const nullableValue = prop['@_Nullable'];
  const nullable = nullableValue !== 'false';
  const annotations = parseAnnotations(prop);

  return {
    name,
    type,
    nullable,
    maxLength: parseNonNegativeInt(prop['@_MaxLength']),
    precision: parseNonNegativeInt(prop['@_Precision']),
    scale: parseNonNegativeInt(prop['@_Scale']),
    isKey: keys.includes(name),
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseNavigationProperty(navProp: XmlElement): ODataNavigationProperty {
  const name = str(navProp['@_Name']) || '';
  const relationship = str(navProp['@_Relationship']) || '';
  const fromRole = str(navProp['@_FromRole']) || '';
  const toRole = str(navProp['@_ToRole']) || '';
  const annotations = parseAnnotations(navProp);

  // OData V4 uses Type; V4.01 may use Target instead (e.g. Windchill models).
  // Store the collection flag in `relationship` so V4 relationship derivation
  // can compute multiplicity (V2 keeps the Association name there).
  const rawType = str(navProp['@_Type']) || str(navProp['@_Target']) || '';
  let targetType: string | undefined;
  let targetTypeQualified: string | undefined;
  let isCollection = false;
  let derivedRelationship = relationship;
  if (rawType) {
    let typeStr = rawType;
    if (typeStr.startsWith('Collection(') && typeStr.endsWith(')')) {
      typeStr = typeStr.slice(11, -1);
      isCollection = true;
    }
    targetTypeQualified = typeStr;
    targetType = shortName(typeStr);
    if (!relationship) {
      derivedRelationship = isCollection ? 'Collection' : '';
    }
  }

  return {
    name,
    relationship: derivedRelationship,
    fromRole,
    toRole,
    targetType,
    targetTypeQualified,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseAssociation(association: XmlElement, namespace: string): ODataRelationship | null {
  const name = str(association['@_Name']);
  if (!name) return null;

  const ends = ensureArray(association['End'] || association['edm:End'] || []);
  if (ends.length < 2) return null;

  const fromEnd = parseAssociationEnd(ends[0]);
  const toEnd = parseAssociationEnd(ends[1]);

  if (!fromEnd || !toEnd) return null;

  return {
    name,
    namespace,
    from: fromEnd,
    to: toEnd,
  };
}

function parseAssociationEnd(end: XmlElement): ODataAssociationEnd | null {
  const type = str(end['@_Type']) || '';
  const role = str(end['@_Role']) || '';
  const multiplicity = String(end['@_Multiplicity'] || '1');
  const entity = shortName(type);

  return {
    entity,
    // `shortName` throws the namespace away; keep it so the diagram can tell
    // two same-named types apart.
    entityQualified: type && type.includes('.') ? type : undefined,
    role,
    multiplicity,
  };
}

function parseAnnotations(el: XmlElement): Record<string, string> | undefined {
  const annElements = ensureArray(el['Annotation'] || el['edm:Annotation'] || []);
  const out: Record<string, string> = {};
  for (const ann of annElements) {
    const term = str(ann['@_Term']);
    if (!term) continue;
    out[term] = annotationValue(ann);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function annotationValue(ann: XmlElement): string {
  for (const attr of ANNOTATION_SCALAR_ATTRS) {
    if (ann[attr] !== undefined) {
      return str(ann[attr]);
    }
  }
  if (ann['@_Null'] !== undefined) {
    return 'null';
  }

  for (const childName of ANNOTATION_SCALAR_CHILDREN) {
    const value = firstChildText(ann, childName);
    if (value !== undefined) {
      return value;
    }
  }
  if (ann['Null'] !== undefined || ann['edm:Null'] !== undefined) {
    return 'null';
  }

  const collection = ann['Collection'] ?? ann['edm:Collection'];
  if (collection !== undefined) {
    const items: string[] = [];
    for (const item of ensureArray(collection)) {
      for (const childName of ANNOTATION_SCALAR_CHILDREN) {
        const value = firstChildText(item, childName);
        if (value !== undefined) {
          items.push(value);
          break;
        }
      }
      if (item['Null'] !== undefined || item['edm:Null'] !== undefined) {
        items.push('null');
      }
    }
    if (items.length > 0) {
      return items.join(', ');
    }
  }

  return '';
}

function firstChildText(el: XmlElement, childName: string): string | undefined {
  const child = el[childName] ?? el[`edm:${childName}`];
  if (child === undefined) return undefined;
  const items = Array.isArray(child) ? (child as unknown[]) : [child];
  const values = items
    .map((item) => {
      if (item !== null && typeof item === 'object') {
        const text = (item as XmlElement)['#text'];
        if (text !== undefined) return str(text);
        return str(item);
      }
      return str(item);
    })
    .filter((v) => v !== '');
  if (values.length === 0) return '';
  return values.join(', ');
}

function labelFromAnnotations(annotations: Record<string, string> | undefined): string | undefined {
  if (!annotations) return undefined;
  return annotations['Core.Description'] || annotations['Core.Label'] || undefined;
}

function ensureArray(value: unknown): XmlElement[] {
  if (Array.isArray(value)) {
    return value as XmlElement[];
  }
  if (value && typeof value === 'object') {
    return [value as XmlElement];
  }
  return [];
}

function str(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const text = (value as XmlElement)['#text'];
    if (text !== undefined) return String(text);
    return String(value);
  }
  return String(value);
}

function shortName(qualified: string): string {
  if (!qualified) return qualified;
  return qualified.includes('.') ? qualified.split('.').pop() || qualified : qualified;
}

function qualify(namespace: string, name: string): string | undefined {
  if (!name) return undefined;
  return namespace ? `${namespace}.${name}` : name;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseInt(String(value), 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}

function boolAttr(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}
