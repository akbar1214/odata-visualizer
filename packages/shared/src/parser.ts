import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import { resolveInheritanceChain, findEntitySetInScope, findTypeInScope } from './resolve.js';
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
  ODataSingleton,
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
      'Singleton',
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

/** Shared empty table, so a document with no aliases needs no allocation. */
const EMPTY_ALIASES: Map<string, string> = new Map();

/** Shared empty set, so an unscoped lookup needs no allocation. */
const EMPTY_NAMESPACES: Set<string> = new Set();

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

  const schemas = childElements(dataServices, 'Schema', 'edm');
  // Per CSDL, `edmx:Reference` is a child of `edmx:Edmx`. It is also accepted
  // inside `DataServices` (and on a `Schema`), which is where this used to look
  // only — so a reference in its standard position was ignored entirely.
  const references = [
    ...childElements(edmx, 'Reference', 'edmx'),
    ...childElements(dataServices, 'Reference', 'edmx'),
    ...schemas.flatMap((s) => childElements(s, 'Reference', 'edmx')),
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
 * A prefix that names a schema in the caller's document is treated as a
 * namespace, not an alias. Both sides of that guard are document-local
 * (CSDL 4.01 §4.2): the alias table and the namespace set are resolved for the
 * document that declares the reference, so a namespace declared in some other
 * document neither rewrites a reference nor blocks a legitimate alias.
 */
function expandAlias(type: string, aliases: Map<string, string>, namespaces?: Set<string>): string {
  const collection = /^Collection\((.*)\)$/.exec(type);
  if (collection) return `Collection(${expandAlias(collection[1], aliases, namespaces)})`;
  if (type.startsWith('Edm.')) return type;

  const dot = type.indexOf('.');
  if (dot <= 0) return type;

  const prefix = type.slice(0, dot);
  if (namespaces?.has(prefix)) return type;

  const namespace = aliases.get(prefix);
  return namespace ? `${namespace}${type.slice(dot)}` : type;
}

function expandAliasesInMetadata(
  metadata: ODataMetadata,
  aliasesForNamespace: (
    namespace?: string,
    element?: object,
    document?: number,
  ) => Map<string, string>,
  namespacesFor: (namespace?: string, element?: object, document?: number) => Set<string>,
): void {
  /**
   * Expansion is per element, not global: an alias is only valid inside the
   * document that declares it, so each element resolves against its own
   * document's table — and against the namespaces that same document declares.
   */
  const expanderFor =
    (namespace: string | undefined, element?: object) =>
    (value: string | undefined): string | undefined =>
      value === undefined
        ? undefined
        : expandAlias(
            value,
            aliasesForNamespace(namespace, element),
            namespacesFor(namespace, element),
          );

  let expand = expanderFor(undefined);

  for (const entity of metadata.entities) {
    expand = expanderFor(entity.namespace);
    entity.baseType = expand(entity.baseType);
    for (const prop of entity.properties) {
      prop.type = expand(prop.type) ?? prop.type;
    }
    for (const nav of entity.navigationProperties) {
      nav.targetTypeQualified = expand(nav.targetTypeQualified);
      nav.targetType = nav.targetTypeQualified
        ? shortName(nav.targetTypeQualified)
        : expand(nav.targetType);
      // V2 stores the association name here and a namespaced generator writes
      // `Self.R1`. V4 stores `'Collection'` or `''`, neither of which contains
      // a dot, so expansion is a no-op for them. Expanded exactly once, here:
      // derivation expands a *copy* for the relationship name and never writes
      // back to this field, so there is no double expansion even for a chained
      // alias. The `??` is a type-level assertion, not a fallback — `expand`
      // returns `undefined` only for `undefined` input, which the guard excludes.
      if (nav.relationship) nav.relationship = expand(nav.relationship) ?? nav.relationship;
    }
  }

  // Relationship endpoints carry their own copy of the type reference. Both
  // the identity (`entity`, now qualified when the document provides one) and
  // the compatibility field are expanded: leaving the identity aliased made a
  // relationship disagree with the navigation property it came from.
  for (const relationship of metadata.relationships) {
    expand = expanderFor(relationship.namespace);
    relationship.from.entityQualified = expand(relationship.from.entityQualified);
    relationship.to.entityQualified = expand(relationship.to.entityQualified);
    relationship.from.entity = expand(relationship.from.entity) ?? relationship.from.entity;
    relationship.to.entity = expand(relationship.to.entity) ?? relationship.to.entity;
  }

  for (const container of metadata.entityContainers) {
    expand = expanderFor(container.namespace);
    for (const set of container.entitySets) {
      set.entityTypeQualified = expand(set.entityTypeQualified);
      set.entityType = set.entityTypeQualified
        ? shortName(set.entityTypeQualified)
        : set.entityType;
      for (const binding of set.navigationPropertyBindings ?? []) {
        binding.target = expand(binding.target) ?? binding.target;
      }
    }
    for (const singleton of container.singletons ?? []) {
      singleton.typeQualified = expand(singleton.typeQualified);
      singleton.type = singleton.typeQualified
        ? shortName(singleton.typeQualified)
        : singleton.type;
    }
  }
  for (const item of [...metadata.actions, ...metadata.functions]) {
    expand = expanderFor(item.namespace);
    item.returnType = expand(item.returnType);
    for (const param of item.parameters) {
      param.type = expand(param.type) ?? param.type;
    }
  }
  for (const typeDefinition of metadata.typeDefinitions) {
    expand = expanderFor(typeDefinition.namespace);
    typeDefinition.underlyingType =
      expand(typeDefinition.underlyingType) ?? typeDefinition.underlyingType;
  }
  for (const enumType of metadata.enumTypes) {
    expand = expanderFor(enumType.namespace);
    if (enumType.underlyingType) {
      enumType.underlyingType = expand(enumType.underlyingType);
    }
  }
  for (const importRecord of metadata.actionImports) {
    expand = expanderFor(undefined, importRecord);
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
    expand = expanderFor(undefined, importRecord);
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
   * Namespace and alias names claimed by `edmx:Include` elements on references
   * that failed to load. The resolve guard tests a stray qualifier against
   * these, so an unrelated failure cannot disable the fallback (#73).
   */
  const unresolvedReferenceIncludes: string[] = [];
  /**
   * `<Annotations Target="...">` blocks, collected per schema and applied once
   * the whole model is parsed. CSDL places most annotations here rather than
   * inline, and `parseAnnotations` reads only direct `<Annotation>` children,
   * so these were dropped entirely.
   */
  const targetedAnnotations: Array<{
    target: string;
    qualifier?: string;
    annotations: Record<string, string>;
    document: number;
    /** Schema that declared the block; bare targets resolve here first. */
    namespace: string;
  }> = [];

  const registry = new Map<string, XmlElement>();
  /**
   * Aliases are scoped to the document that declares them (CSDL 4.01 §4.2: *"An
   * alias is only valid within the document in which it is declared"*).
   *
   * A single document-global map made two documents that each declare the same
   * alias collide on a first-wins basis, so a derived type in the second
   * document silently inherited from the *first* document's base — wrong
   * properties, wrong keys, wrong inheritance chain.
   */
  const aliasesByDocument = new Map<number, Map<string, string>>();
  /**
   * Namespaces declared by each document's own schemas, for the prefix guard
   * in `expandAlias`. Both an alias and the namespace it could collide with
   * are document-local (CSDL 4.01 §4.2), so a namespace declared elsewhere in
   * the model must not decide how this document's references resolve.
   */
  const namespacesByDocument = new Map<number, Set<string>>();
  /** Which document each schema namespace came from. */
  const documentOfNamespace = new Map<string, number>();
  /** Imports carry no namespace, so their document is recorded directly. */
  const documentOfElement = new WeakMap<object, number>();
  let nextDocumentId = 0;

  const aliasesFor = (document: number): Map<string, string> => {
    let table = aliasesByDocument.get(document);
    if (!table) {
      table = new Map<string, string>();
      aliasesByDocument.set(document, table);
    }
    return table;
  };

  const queue: XmlElement[] = [];
  const visitedUris = new Set<string>();
  const maxExternalDocuments = options.maxExternalDocuments ?? 25;
  let externalDocumentsLoaded = 0;

  const includesOf = (owner: XmlElement): XmlElement[] => [
    ...ensureArray(owner['Include']),
    ...ensureArray(owner['edmx:Include']),
    ...ensureArray(owner['edm:Include']),
  ];

  /**
   * Record a reference that could not be loaded, together with the namespace
   * and alias names its `edmx:Include` elements claimed. The resolve guard
   * needs the names, not just the failure: a qualifier can only have come from
   * a document that actually included it (#73).
   */
  const recordUnresolvedReference = (uri: string, reference: XmlElement): void => {
    if (!unresolvedReferences.includes(uri)) unresolvedReferences.push(uri);
    for (const include of includesOf(reference)) {
      for (const attribute of ['@_Namespace', '@_Alias']) {
        const name = str(include[attribute]);
        if (name && !unresolvedReferenceIncludes.includes(name)) {
          unresolvedReferenceIncludes.push(name);
        }
      }
    }
  };

  const registerSchema = (schema: XmlElement, document: number): void => {
    const namespace = str(schema['@_Namespace']);
    if (!namespace) return;
    let documentNamespaces = namespacesByDocument.get(document);
    if (!documentNamespaces) {
      documentNamespaces = new Set<string>();
      namespacesByDocument.set(document, documentNamespaces);
    }
    documentNamespaces.add(namespace);
    if (registry.has(namespace)) return;
    registry.set(namespace, schema);
    documentOfNamespace.set(namespace, document);
    queue.push(schema);
  };

  const registerAliases = (owner: XmlElement, document: number): void => {
    // A schema may alias its own namespace — `<Schema Namespace="N" Alias="Self">`
    // — and every generator that writes `Self.Type` references relies on it.
    // Reading only `Include` here left those references unexpanded, so
    // `BaseType="Self.Base"` produced no inheritance chain and `getEffectiveKeys`
    // returned nothing.
    const table = aliasesFor(document);
    const ownerNamespace = str(owner['@_Namespace']);
    const ownerAlias = str(owner['@_Alias']);
    if (ownerNamespace && ownerAlias && !table.has(ownerAlias)) {
      table.set(ownerAlias, ownerNamespace);
    }

    for (const include of includesOf(owner)) {
      const namespace = str(include['@_Namespace']);
      const alias = str(include['@_Alias']);
      if (namespace && alias && !table.has(alias)) {
        table.set(alias, namespace);
      }
    }
  };

  for (const schema of rootDocument.schemas) {
    registerSchema(schema, nextDocumentId);
    registerAliases(schema, nextDocumentId);
  }
  // A reference is declared *by* the document that contains it, so its
  // `Include` aliases belong to that document, not to the one it loads.
  for (const reference of rootDocument.references) {
    registerAliases(reference, nextDocumentId);
  }

  const loadReferences = async (references: XmlElement[], document: number): Promise<void> => {
    for (const reference of references) {
      const uri = str(reference['@_Uri']);
      // A reference's `Include` aliases are declared by the *referencing*
      // document, so they belong to it whether or not the referenced document
      // loads and whether or not it was already visited. Registering this
      // inside the `try` below meant a failed fetch silently dropped aliases
      // that a root-level reference would have kept.
      registerAliases(reference, document);
      if (!uri) continue;

      if (!options.loadExternal) {
        recordUnresolvedReference(uri, reference);
        continue;
      }

      const absoluteUri = resolveReferenceUri(uri, options.baseUri);
      if (visitedUris.has(absoluteUri)) continue;

      if (externalDocumentsLoaded >= maxExternalDocuments) {
        recordUnresolvedReference(uri, reference);
        continue;
      }

      visitedUris.add(absoluteUri);
      externalDocumentsLoaded += 1;
      try {
        const externalDocument = parseEdmxDocument(await options.loadExternal(absoluteUri));
        // A loaded document gets its own alias scope, so an alias it declares
        // cannot rewrite a reference in another document, and vice versa.
        nextDocumentId += 1;
        const externalDocumentId = nextDocumentId;
        for (const schema of externalDocument.schemas) {
          registerSchema(schema, externalDocumentId);
          registerAliases(schema, externalDocumentId);
        }
        await loadReferences(externalDocument.references, externalDocumentId);
      } catch {
        recordUnresolvedReference(uri, reference);
      }
    }
  };

  await loadReferences(rootDocument.references, nextDocumentId);

  const documentIdFor = (namespace?: string, element?: object, document?: number): number =>
    (element !== undefined ? documentOfElement.get(element) : undefined) ??
    document ??
    (namespace ? documentOfNamespace.get(namespace) : undefined) ??
    0;
  const aliasesForNamespace = (
    namespace?: string,
    element?: object,
    document?: number,
  ): Map<string, string> =>
    aliasesByDocument.get(documentIdFor(namespace, element, document)) ?? EMPTY_ALIASES;
  /** The namespaces in scope for the same element or document. */
  const namespacesFor = (namespace?: string, element?: object, document?: number): Set<string> =>
    namespacesByDocument.get(documentIdFor(namespace, element, document)) ?? EMPTY_NAMESPACES;

  while (queue.length > 0) {
    const schema = queue.shift() as XmlElement;
    const namespace = str(schema['@_Namespace']) || '';
    const currentDocument = documentOfNamespace.get(namespace) ?? 0;
    const entityTypeNames = new Set<string>();

    const entityTypes = childElements(schema, 'EntityType', 'edm');
    for (const entityType of entityTypes) {
      const entity = parseEntityType(entityType, namespace);
      if (entity.name) {
        entityTypeNames.add(entity.name);
        entities.push(entity);
      }
    }

    const complexTypes = childElements(schema, 'ComplexType', 'edm');
    for (const complexType of complexTypes) {
      const complex = parseComplexType(complexType, namespace);
      if (complex.name) {
        entities.push(complex);
      }
    }

    const associations = childElements(schema, 'Association', 'edm');
    for (const association of associations) {
      const rel = parseAssociation(association, namespace);
      if (rel) {
        relationships.push(rel);
      }
    }

    const enumElements = childElements(schema, 'EnumType', 'edm');
    for (const enumEl of enumElements) {
      const parsedEnum = parseEnumType(enumEl, namespace);
      if (parsedEnum) {
        enumTypes.push(parsedEnum);
      }
    }

    const typeDefElements = childElements(schema, 'TypeDefinition', 'edm');
    for (const typeDefEl of typeDefElements) {
      const parsedTypeDef = parseTypeDefinition(typeDefEl, namespace);
      if (parsedTypeDef) {
        typeDefinitions.push(parsedTypeDef);
      }
    }

    const actionDefs = new Map<string, ODataAction>();
    const actionElements = childElements(schema, 'Action', 'edm');
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
    const functionElements = childElements(schema, 'Function', 'edm');
    for (const funcEl of functionElements) {
      const func = parseFunction(funcEl, namespace);
      if (func.name && !functionDefs.has(func.name)) {
        functionDefs.set(func.name, func);
      }
      if (func.name) {
        functions.push(func);
      }
    }

    const containers = childElements(schema, 'EntityContainer', 'edm');
    for (const container of containers) {
      const containerName = str(container['@_Name']) || '';
      const entitySets = childElements(container, 'EntitySet', 'edm');
      const parsedEntitySets: ODataEntitySet[] = [];
      for (const entitySet of entitySets) {
        const es = parseEntitySet(entitySet);
        if (es) {
          parsedEntitySets.push(es);
        }
      }
      const singletons = childElements(container, 'Singleton', 'edm')
        .map(parseSingleton)
        .filter((s): s is ODataSingleton => s !== null);
      const containerAnnotations = parseAnnotations(container);
      if (containerName || parsedEntitySets.length > 0 || singletons.length > 0) {
        entityContainers.push({
          name: containerName,
          namespace,
          label: labelFromAnnotations(containerAnnotations),
          entitySets: parsedEntitySets,
          singletons: singletons.length > 0 ? singletons : undefined,
          annotations: containerAnnotations,
        });
      }

      const funcImports = childElements(container, 'FunctionImport', 'edm');
      for (const funcImport of funcImports) {
        const fi = parseFunctionImport(funcImport, functionDefs, qualify(namespace, containerName));
        if (fi) {
          documentOfElement.set(fi, currentDocument);
          functionImports.push(fi);
        }
      }

      const actImports = childElements(container, 'ActionImport', 'edm');
      for (const actionImport of actImports) {
        const ai = parseActionImport(actionImport, actionDefs, qualify(namespace, containerName));
        if (ai) {
          documentOfElement.set(ai, currentDocument);
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
        const rel = relationshipFromNavigationProperty(entity, nav, namespace, (v) =>
          expandAlias(v, aliasesForNamespace(namespace), namespacesFor(namespace)),
        );
        if (!rel) continue;
        if (!relationships.some((r) => isSameDerivedRelationship(r, rel))) {
          relationships.push(rel);
        }
      }
    }

    // Schema-level annotations, applied after the model is complete so a target
    // may name anything in any schema.
    for (const annotationsEl of childElements(schema, 'Annotations', 'edm')) {
      const target = str(annotationsEl['@_Target']);
      if (!target) continue;
      const annotations = parseAnnotations(annotationsEl);
      if (annotations) {
        targetedAnnotations.push({
          target,
          qualifier: str(annotationsEl['@_Qualifier']) || undefined,
          annotations,
          document: currentDocument,
          namespace,
        });
      }
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

  expandAliasesInMetadata(metadata, aliasesForNamespace, namespacesFor);
  applyTargetedAnnotations(metadata, targetedAnnotations, aliasesForNamespace, namespacesFor);

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
  if (unresolvedReferenceIncludes.length > 0) {
    metadata.unresolvedReferenceIncludes = unresolvedReferenceIncludes;
  }

  return metadata;
}

/**
 * Two derived relationships are the same when they are either an exact
 * duplicate, or the two halves of one bidirectional navigation property
 * (`Order.Customer` and `Customer.Orders`). Distinct same-direction
 * navigation properties between the same pair of types stay separate.
 *
 * Endpoints are compared by their stored identity, which is the qualified
 * type. The short name made two same-named types in different namespaces look
 * like the same relationship, so the second one was dropped.
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
  // Expanded here, not in the later pass: the relationship is derived *during*
  // parsing, so expanding only `nav.relationship` afterwards left this copy
  // saying `Self.R1` while the navigation property said `N.R1`.
  const associationName =
    nav.relationship && nav.relationship !== 'Collection'
      ? expand(nav.relationship)
      : `${entity.name}_${nav.name}`;
  const targetReference = expand(nav.targetTypeQualified ?? nav.targetType) ?? nav.targetType;
  const targetIdentity =
    targetReference.includes('.') || targetReference.startsWith('Edm.')
      ? targetReference
      : `${namespace}.${targetReference}`;
  return {
    name: associationName,
    namespace,
    from: {
      // The endpoint identity is the qualified name, not its short form: two
      // namespaces can declare the same type name, and a short endpoint made
      // the two relationships indistinguishable (deduplication merged them and
      // consumers resolved them to whichever type came first).
      entity: entity.qualifiedName ?? entity.name,
      entityQualified: entity.qualifiedName,
      role: nav.fromRole || entity.name,
      multiplicity: isCollection ? '*' : '1',
    },
    to: {
      // Expanded *and* qualified before deduplication, which runs during parsing
      // and compares stored identities. An alias left unexpanded (`self.Gadget`)
      // or an unqualified reference left short (`Gadget`) did not match the same
      // type written `N.Gadget`, so the two mirrored halves of one association
      // both survived. An unqualified reference means the enclosing namespace,
      // so the parser can qualify it too.
      entity: targetIdentity,
      // Kept for consumers written against the old shape; the parser no longer
      // discards the qualified target.
      entityQualified: nav.targetTypeQualified ? expand(nav.targetTypeQualified) : targetIdentity,
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
 * Precedence:
 *
 * - An annotation declared on the element itself wins over a targeted one — the
 *   element's own declaration is the more specific statement.
 * - Among targeted blocks, the last one in document order wins, matching the
 *   rule one level down where the last `<Annotation>` in a block wins.
 * - An annotation on a property of an entity in a particular entity set or
 *   singleton overrides one targeted via the declaring structured type
 *   (CSDL 4.01 §14.2.2), regardless of document order.
 * - A bare target (no dot in its first segment) resolves in the schema that
 *   declared the block first, then across the model. Every lookup is exact-case
 *   first with a case-insensitive fallback, per the project-wide case policy.
 * - A block carrying `Qualifier` is rejected: `annotations` is a
 *   `Record<term, string>` and cannot represent the qualifier, so attaching
 *   either value as if it were unqualified would be silently wrong.
 *
 * Supported target paths, from §14.2.2:
 *
 * - `NS.Type`, `NS.EnumType`, `NS.EnumType/Member`, `NS.TypeDefinition`,
 *   `NS.Action`, `NS.Function` (with `(parameterTypes)` to pick one overload)
 *   and `NS.Container`;
 * - `NS.Type/Property/Nested` with property, navigation-property and type-cast
 *   segments; a cast must name the current type or a type on its inheritance
 *   chain, so an unrelated type is rejected rather than attached to; a nested
 *   annotation is stored on the property of the complex type that declares it,
 *   the closest shape the model has;
 * - `NS.Container/EntitySet`, `NS.Container/Singleton`,
 *   `NS.Container/ActionImport`, `NS.Container/FunctionImport`, and a
 *   property/navigation path below a set or singleton;
 * - the unqualified `Container/Set` spelling, for hand-written documents.
 *
 * **Known limitation.** A property path below a set or singleton is stored on
 * the property of the set's *type*, because that is the only shape the model
 * has. §14.2.2 scopes such an annotation to the set, so two sets over one type
 * share one slot and the last block wins. Nothing renders property-level
 * annotations today, so storing them per set would add a field no consumer
 * reads; the collision is recorded and pinned by a test instead.
 *
 * Still unsupported: parameter and `$ReturnType` targets (the model has no
 * field for them), term casts, and the trailing `@Term#Qualifier` form — each
 * pinned by a test as a no-op rather than an attachment. A target naming a term
 * definition itself (`MySchema.MyTerm`) is a no-op too: terms are not part of
 * the parsed model, so there is nothing to decorate.
 *
 * Targets that name nothing in the document are ignored rather than reported:
 * an `Annotations` block commonly targets a type from an `edmx:Reference` that
 * could not be loaded, which `unresolvedReferences` already covers.
 */
function applyTargetedAnnotations(
  metadata: ODataMetadata,
  targeted: Array<{
    target: string;
    qualifier?: string;
    annotations: Record<string, string>;
    document: number;
    namespace: string;
  }>,
  aliasesForNamespace: (
    namespace?: string,
    element?: object,
    document?: number,
  ) => Map<string, string>,
  namespacesFor: (namespace?: string, element?: object, document?: number) => Set<string>,
): void {
  // Inline annotations win over targeted ones. Snapshot which terms each
  // element declared inline *before* any block is applied, so a later block
  // cannot overwrite one and a bare target cannot win by arriving first.
  const inlineTerms = new WeakMap<object, Set<string>>();
  const rememberInline = (element: Annotatable) => {
    if (element.annotations) {
      inlineTerms.set(element, new Set(Object.keys(element.annotations)));
    }
  };
  for (const entity of metadata.entities) {
    rememberInline(entity);
    for (const property of entity.properties) rememberInline(property);
    for (const navigation of entity.navigationProperties) rememberInline(navigation);
  }
  for (const container of metadata.entityContainers) {
    rememberInline(container);
    for (const set of container.entitySets) rememberInline(set);
    for (const singleton of container.singletons ?? []) rememberInline(singleton);
  }
  for (const action of metadata.actions) rememberInline(action);
  for (const func of metadata.functions) rememberInline(func);
  for (const enumType of metadata.enumTypes) {
    rememberInline(enumType);
    for (const member of enumType.members) rememberInline(member);
  }
  for (const typeDefinition of metadata.typeDefinitions) rememberInline(typeDefinition);
  for (const importRecord of metadata.actionImports) rememberInline(importRecord);
  for (const importRecord of metadata.functionImports) rememberInline(importRecord);

  const applyTo = (element: Annotatable, extra: Record<string, string>): void => {
    const protectedTerms = inlineTerms.get(element);
    const merged = { ...(element.annotations ?? {}) };
    let changed = false;
    for (const [term, value] of Object.entries(extra)) {
      if (protectedTerms?.has(term)) continue;
      merged[term] = value;
      changed = true;
    }
    if (!changed) return;
    element.annotations = merged;
    element.label = labelFromAnnotations(merged) ?? element.label;
  };

  // §14.2.2: a set- or singleton-qualified property annotation overrides one
  // targeted via the declaring structured type. Defer those blocks to a second
  // pass so the override wins wherever the block sits in the document.
  const overrides: Array<{ element: Annotatable; annotations: Record<string, string> }> = [];

  for (const block of targeted) {
    // Rejected on purpose. The combination of target, term and qualifier
    // uniquely identifies an annotation (CSDL 4.01 §14.2.1), and `annotations`
    // cannot carry the qualifier, so a qualified block is dropped rather than
    // flattened into the unqualified map. No consumer acts on a qualifier yet;
    // revisit when one does.
    if (block.qualifier) continue;

    // The namespace guard added in #25 matters here too: a prefix that names a
    // schema declared in this block's document is a namespace, not an alias,
    // so an annotation target cannot be rewritten by a same-named alias from
    // that document. Resolved for the block's own document, not the model.
    const aliases = aliasesForNamespace(undefined, undefined, block.document);
    const namespaces = namespacesFor(undefined, undefined, block.document);
    // Every qualified name in a target path is in scope, so every segment is
    // expanded. Expanding the whole string only reaches the first segment,
    // which silently dropped a cast written with an alias:
    // `N.Derived/Self.Base/BaseProp` resolved to nothing.
    const expanded = expandAlias(block.target, aliases, namespaces);
    const segments = expanded
      .split('/')
      .map((segment) => expandAlias(segment, aliases, namespaces));
    const scope = block.namespace;

    const selector = splitOverloadSelector(segments[0]);
    if (selector) {
      // `NS.Function(Edm.String, Edm.Int32)` or `NS.Action(N.BindingType)` /
      // `NS.Action()`. A further segment would target a parameter or
      // `$ReturnType`, which the model has no field for.
      if (segments.length > 1) continue;
      const overloads = findOverloads(metadata, selector, scope, aliases, namespaces);
      if (overloads) {
        for (const overload of overloads) applyTo(overload, block.annotations);
      }
      continue;
    }

    if (segments.length >= 2) {
      const first = findNamedTargets(metadata, segments[0], scope);

      // `NS.Type/Property[/Nested...]`, including type-cast segments. The
      // first segment must be qualified; an unqualified pair is a container
      // child, which the branch below resolves.
      if (segments[0].includes('.')) {
        const owner = first.find((candidate) => candidate.kind === 'entity');
        if (owner) {
          const leaf = walkPropertyPath(metadata, owner.element as ODataEntity, segments.slice(1));
          if (leaf) {
            applyTo(leaf, block.annotations);
            continue;
          }
        }

        // `NS.EnumType/Member`.
        const enumType = first.find((candidate) => candidate.kind === 'enum');
        if (enumType && segments.length === 2) {
          const member = findEnumMember(enumType.element as ODataEnumType, segments[1]);
          if (member) {
            applyTo(member, block.annotations);
            continue;
          }
        }
      }

      // `NS.Container/Child` and the unqualified `Container/Child`.
      const containerCandidate = first.find((candidate) => candidate.kind === 'container');
      if (containerCandidate) {
        const container = containerCandidate.element as ODataEntityContainer;
        const child = segments[1];

        const set = findSetIn(container, child);
        if (set) {
          if (segments.length === 2) {
            applyTo(set, block.annotations);
            continue;
          }
          const leaf = walkFromTypeReference(
            metadata,
            set.entityTypeQualified ?? set.entityType,
            container.namespace ?? scope,
            segments.slice(2),
          );
          if (leaf) {
            overrides.push({ element: leaf, annotations: block.annotations });
            continue;
          }
        }

        const singleton = findSingletonIn(container, child);
        if (singleton) {
          if (segments.length === 2) {
            applyTo(singleton, block.annotations);
            continue;
          }
          const leaf = walkFromTypeReference(
            metadata,
            singleton.typeQualified ?? singleton.type,
            container.namespace ?? scope,
            segments.slice(2),
          );
          if (leaf) {
            overrides.push({ element: leaf, annotations: block.annotations });
            continue;
          }
        }

        if (segments.length === 2) {
          const importRecord =
            findImportIn(metadata.actionImports, container, child) ??
            findImportIn(metadata.functionImports, container, child);
          if (importRecord) {
            applyTo(importRecord, block.annotations);
            continue;
          }
        }
      }
      continue;
    }

    // A single segment: a schema child, then a container-less entity-set name.
    const named = findNamedTargets(metadata, expanded, scope);
    if (named.length > 0) {
      if (named[0].kind === 'action' || named[0].kind === 'function') {
        // Every overload shares the name; a target without parentheses applies
        // to all of them.
        for (const candidate of named) {
          if (candidate.kind === 'action' || candidate.kind === 'function') {
            applyTo(candidate.element, block.annotations);
          }
        }
      } else {
        applyTo(named[0].element, block.annotations);
      }
      continue;
    }
    const set = findEntitySetInScope(metadata, expanded, scope);
    if (set) applyTo(set, block.annotations);
  }

  for (const override of overrides) applyTo(override.element, override.annotations);
}

/** Any model element a targeted block can decorate. */
interface Annotatable {
  annotations?: Record<string, string>;
  label?: string;
}

/** A schema child a target's first segment can name, with its identities. */
interface NamedCandidate {
  kind: 'entity' | 'enum' | 'typeDefinition' | 'action' | 'function' | 'container';
  qualified: string;
  short: string;
  namespace: string;
  element: Annotatable;
}

/**
 * Every schema child a target's first segment may name.
 *
 * Candidates are emitted in a fixed kind order (types, enums, type
 * definitions, callables, containers), which decides a tie between two kinds
 * that share a name — invalid CSDL, but the parser is lenient about it.
 */
function namedCandidates(metadata: ODataMetadata): NamedCandidate[] {
  const candidates: NamedCandidate[] = [];
  for (const entity of metadata.entities) {
    candidates.push({
      kind: 'entity',
      qualified: entity.qualifiedName ?? entity.name,
      short: entity.name,
      namespace: entity.namespace ?? '',
      element: entity,
    });
  }
  for (const enumType of metadata.enumTypes) {
    candidates.push({
      kind: 'enum',
      qualified: enumType.qualifiedName ?? enumType.name,
      short: enumType.name,
      namespace: enumType.namespace ?? '',
      element: enumType,
    });
  }
  for (const typeDefinition of metadata.typeDefinitions) {
    candidates.push({
      kind: 'typeDefinition',
      qualified: typeDefinition.qualifiedName ?? typeDefinition.name,
      short: typeDefinition.name,
      namespace: typeDefinition.namespace ?? '',
      element: typeDefinition,
    });
  }
  for (const action of metadata.actions) {
    candidates.push({
      kind: 'action',
      qualified: action.qualifiedName ?? action.name,
      short: action.name,
      namespace: action.namespace ?? '',
      element: action,
    });
  }
  for (const func of metadata.functions) {
    candidates.push({
      kind: 'function',
      qualified: func.qualifiedName ?? func.name,
      short: func.name,
      namespace: func.namespace ?? '',
      element: func,
    });
  }
  for (const container of metadata.entityContainers) {
    candidates.push({
      kind: 'container',
      qualified: container.namespace ? `${container.namespace}.${container.name}` : container.name,
      short: container.name,
      namespace: container.namespace ?? '',
      element: container,
    });
  }
  return candidates;
}

/**
 * How well a candidate matches a target name; lower is better, -1 no match.
 *
 * Mirrors the project-wide case policy: exact case first, then a
 * case-insensitive fallback, and for a bare name the declaring schema's
 * namespace before the rest of the model.
 */
function nameMatchTier(
  candidate: NamedCandidate,
  name: string,
  preferredNamespace: string,
): number {
  if (name.includes('.')) {
    if (candidate.qualified === name) return 0;
    if (candidate.qualified.toLowerCase() === name.toLowerCase()) return 1;
    return -1;
  }
  if (candidate.namespace === preferredNamespace && candidate.short === name) return 0;
  if (candidate.short === name) return 1;
  if (
    candidate.namespace.toLowerCase() === preferredNamespace.toLowerCase() &&
    candidate.short.toLowerCase() === name.toLowerCase()
  ) {
    return 2;
  }
  if (candidate.short.toLowerCase() === name.toLowerCase()) return 3;
  return -1;
}

/** The best-matching schema children for a single-segment target. */
function findNamedTargets(
  metadata: ODataMetadata,
  name: string,
  preferredNamespace: string,
): NamedCandidate[] {
  let best = Number.POSITIVE_INFINITY;
  let found: NamedCandidate[] = [];
  for (const candidate of namedCandidates(metadata)) {
    const tier = nameMatchTier(candidate, name, preferredNamespace);
    if (tier < 0) continue;
    if (tier < best) {
      best = tier;
      found = [candidate];
    } else if (tier === best) {
      found.push(candidate);
    }
  }
  return found;
}

/** Split `NS.Function(Edm.String, Edm.Int32)` into its name and parameter types. */
function splitOverloadSelector(
  segment: string,
): { name: string; parameterTypes: string[] } | undefined {
  const open = segment.indexOf('(');
  if (open < 0 || !segment.endsWith(')')) return undefined;
  const name = segment.slice(0, open);
  if (!name) return undefined;
  const inside = segment.slice(open + 1, -1).trim();
  return {
    name,
    parameterTypes: inside === '' ? [] : inside.split(',').map((type) => type.trim()),
  };
}

/** All overloads of `selector.name` whose parameter list matches the selector. */
function findOverloads(
  metadata: ODataMetadata,
  selector: { name: string; parameterTypes: string[] },
  preferredNamespace: string,
  aliases: Map<string, string>,
  namespaces: Set<string>,
): Array<ODataAction | ODataFunction> | undefined {
  const callables = findNamedTargets(metadata, selector.name, preferredNamespace).filter(
    (candidate) => candidate.kind === 'action' || candidate.kind === 'function',
  );
  if (callables.length === 0) return undefined;

  const parameterTypes = selector.parameterTypes.map((type) =>
    expandAlias(type, aliases, namespaces),
  );
  const exact = callables.filter((candidate) => matchesOverload(candidate, parameterTypes, false));
  if (exact.length > 0) {
    return exact.map((candidate) => candidate.element as ODataAction | ODataFunction);
  }
  return callables
    .filter((candidate) => matchesOverload(candidate, parameterTypes, true))
    .map((candidate) => candidate.element as ODataAction | ODataFunction);
}

/**
 * Does an overload match the parenthesised parameter list?
 *
 * For a function the list is every parameter type in order. For an action the
 * spec uses the binding parameter type for a bound overload and an empty list
 * for the unbound overload.
 */
function matchesOverload(
  candidate: NamedCandidate,
  parameterTypes: string[],
  ignoreCase: boolean,
): boolean {
  const callable = candidate.element as ODataAction | ODataFunction;
  const types = callable.parameters.map((parameter) => parameter.type);
  const equal = (a: string, b: string) =>
    ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;

  if (candidate.kind === 'action') {
    if (parameterTypes.length === 0) return !callable.isBound;
    return (
      callable.isBound &&
      parameterTypes.length === 1 &&
      types.length > 0 &&
      equal(types[0], parameterTypes[0])
    );
  }

  return (
    types.length === parameterTypes.length &&
    types.every((type, index) => equal(type, parameterTypes[index]))
  );
}

/**
 * Walk property, navigation-property and type-cast segments from a type.
 *
 * Returns the property the last segment names. A nested path (`Type/Complex/
 * Nested`) is stored on the property of the complex type that declares it —
 * the model has no per-path slot, so the annotation is visible wherever that
 * complex type is used.
 */
function walkPropertyPath(
  metadata: ODataMetadata,
  startType: ODataEntity,
  segments: string[],
): ODataProperty | ODataNavigationProperty | undefined {
  let current: ODataEntity | undefined = startType;
  // The most derived type the path can still describe. A cast may widen it to
  // an ancestor or narrow it within this branch; a cast into a sibling branch
  // is not a type the path started at can reach (#53.2).
  let branch: ODataEntity = startType;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.includes('.')) {
      // A qualified segment is a type cast, not a property name. It only names
      // a type the path can reach when that type and the branch share an
      // inheritance chain; an unrelated type used to attach the annotation to
      // a property the target never mentions. Checking the *current* type
      // alone accepted an up-cast followed by a down-cast into a sibling:
      // `Derived/Base/OtherDerived` validated each step while the path as a
      // whole can never reach `OtherDerived`.
      if (!current) return undefined;
      const cast = findTypeInScope(metadata.entities, segment, current.namespace);
      if (!cast || !isRelatedByInheritance(cast, branch, metadata.entities)) return undefined;
      if (resolveInheritanceChain(cast, metadata.entities).includes(branch)) {
        // Narrowing inside the branch moves it down with the cast.
        branch = cast;
      }
      current = cast;
      continue;
    }
    if (!current) return undefined;
    const property = findPropertyOrNavigation(current, segment, metadata.entities);
    if (!property) return undefined;
    if (index === segments.length - 1) return property;

    const reference = isNavigationProperty(property)
      ? (property.targetTypeQualified ?? property.targetType)
      : property.type;
    current = reference
      ? findTypeInScope(metadata.entities, reference, current.namespace)
      : undefined;
    if (!current) return undefined;
    // A property segment moves to a new type, so the branch re-anchors: casts
    // below this type are judged against it, not the type the path began at.
    branch = current;
  }
  return undefined;
}

/**
 * Is one type the same as, a base of, or a derived type of the other?
 *
 * A chain that runs out at a reference the model never loaded cannot prove two
 * types unrelated (#73's partial models) — but only while the two resolved
 * chains are disjoint. When they already share an ancestor, the truncation is
 * above that ancestor, and no acyclic base chain can connect the branches
 * through it (#53.2's sibling hop through a bridge).
 */
function isRelatedByInheritance(a: ODataEntity, b: ODataEntity, entities: ODataEntity[]): boolean {
  const chainA = resolveInheritanceChain(a, entities);
  const chainB = resolveInheritanceChain(b, entities);
  if (chainA.includes(b) || chainB.includes(a)) return true;

  const truncatedA = chainA[chainA.length - 1].baseType !== undefined;
  const truncatedB = chainB[chainB.length - 1].baseType !== undefined;
  if (!truncatedA && !truncatedB) return false;
  return !chainA.some((entity) => chainB.includes(entity));
}

/** Resolve a set's or singleton's declared type, then walk the path. */
function walkFromTypeReference(
  metadata: ODataMetadata,
  reference: string,
  scope: string,
  segments: string[],
): ODataProperty | ODataNavigationProperty | undefined {
  const startType = findTypeInScope(metadata.entities, reference, scope);
  if (!startType) return undefined;
  return walkPropertyPath(metadata, startType, segments);
}

function isNavigationProperty(
  property: ODataProperty | ODataNavigationProperty,
): property is ODataNavigationProperty {
  return 'relationship' in property;
}

/**
 * A structural or navigation property by name.
 *
 * Exact case wins across both lists before the case-insensitive fallback, so a
 * property spelled exactly is never shadowed by a differently-cased navigation
 * property.
 */
function findPropertyOrNavigation(
  owner: ODataEntity,
  name: string,
  entities: ODataEntity[],
): ODataProperty | ODataNavigationProperty | undefined {
  const on = (type: ODataEntity): ODataProperty | ODataNavigationProperty | undefined => {
    const exact =
      type.properties.find((property) => property.name === name) ??
      type.navigationProperties.find((navigation) => navigation.name === name);
    if (exact) return exact;

    const needle = name.toLowerCase();
    return (
      type.properties.find((property) => property.name.toLowerCase() === needle) ??
      type.navigationProperties.find((navigation) => navigation.name.toLowerCase() === needle)
    );
  };

  const direct = on(owner);
  if (direct) return direct;

  // An inherited property is part of the derived type everywhere else in this
  // parser — `getEffectiveProperties` walks the chain — so a target path naming
  // one resolves here too, instead of silently requiring an explicit cast.
  for (const base of resolveInheritanceChain(owner, entities)) {
    if (base === owner) continue;
    const inherited = on(base);
    if (inherited) return inherited;
  }
  return undefined;
}

/** An entity set within one container. Exact case first, then case-insensitive. */
function findSetIn(container: ODataEntityContainer, name: string): ODataEntitySet | undefined {
  const exact = container.entitySets.find((set) => set.name === name);
  if (exact) return exact;
  const needle = name.toLowerCase();
  return container.entitySets.find((set) => set.name.toLowerCase() === needle);
}

/** A singleton within one container. Exact case first, then case-insensitive. */
function findSingletonIn(
  container: ODataEntityContainer,
  name: string,
): ODataSingleton | undefined {
  const singletons = container.singletons ?? [];
  const exact = singletons.find((singleton) => singleton.name === name);
  if (exact) return exact;
  const needle = name.toLowerCase();
  return singletons.find((singleton) => singleton.name.toLowerCase() === needle);
}

/** An enum member. Exact case first, then case-insensitive. */
function findEnumMember(enumType: ODataEnumType, name: string): ODataEnumMember | undefined {
  const exact = enumType.members.find((member) => member.name === name);
  if (exact) return exact;
  const needle = name.toLowerCase();
  return enumType.members.find((member) => member.name.toLowerCase() === needle);
}

/**
 * An action or function import belonging to a container.
 *
 * Imports parsed from CSDL record their container, so a target naming a
 * different container does not attach here. A hand-built import without the
 * field is accepted by name, since there is nothing to compare.
 */
function findImportIn<T extends ODataActionImport | ODataFunctionImport>(
  imports: T[],
  container: ODataEntityContainer,
  name: string,
): T | undefined {
  const containerName = container.namespace
    ? `${container.namespace}.${container.name}`
    : container.name;
  const owned = imports.filter(
    (record) => record.container === undefined || record.container === containerName,
  );
  const exact = owned.find((record) => record.name === name);
  if (exact) return exact;
  const needle = name.toLowerCase();
  return owned.find((record) => record.name.toLowerCase() === needle);
}

function parseEntitySet(entitySet: XmlElement): ODataEntitySet | null {
  const name = str(entitySet['@_Name']);
  const rawType = str(entitySet['@_EntityType']);
  if (!name || !rawType) return null;

  const entityType = shortName(rawType);
  const bindings = childElements(entitySet, 'NavigationPropertyBinding', 'edm')
    .map(parseNavigationPropertyBinding)
    .filter((b): b is ODataNavigationPropertyBinding => b !== null);
  const annotations = parseAnnotations(entitySet);

  return {
    name,
    entityType,
    entityTypeQualified: rawType || undefined,
    creatable: boolAttr(entitySet['@_Creatable']),
    updatable: boolAttr(entitySet['@_Updatable']),
    deletable: boolAttr(entitySet['@_Deletable']),
    navigable: boolAttr(entitySet['@_Navigable']),
    navigationPropertyBindings: bindings.length > 0 ? bindings : undefined,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseSingleton(el: XmlElement): ODataSingleton | null {
  const name = str(el['@_Name']);
  const rawType = str(el['@_Type']);
  if (!name || !rawType) return null;
  const annotations = parseAnnotations(el);
  return {
    name,
    type: shortName(rawType),
    typeQualified: rawType || undefined,
    label: labelFromAnnotations(annotations),
    annotations,
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
  container?: string,
): ODataActionImport | null {
  const name = str(actionImport['@_Name']);
  if (!name) return null;

  const rawAction = str(actionImport['@_Action']) || '';
  const actionName = shortName(rawAction);
  const def = actionDefs.get(actionName);
  const entitySet = str(actionImport['@_EntitySet']) || undefined;
  const annotations = parseAnnotations(actionImport);

  return {
    name,
    actionName,
    qualifiedActionName: def?.qualifiedName || rawAction || undefined,
    entitySet,
    container,
    isBound: def?.isBound,
    parameter: def && def.parameters.length > 0 ? def.parameters : undefined,
    returnType: def?.returnType,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseAction(el: XmlElement, namespace: string): ODataAction {
  const name = str(el['@_Name']) || '';
  const isBound = str(el['@_IsBound']) === 'true';
  const parameters = parseParameters(el, isBound);
  const returnType = parseReturnType(el);
  const annotations = parseAnnotations(el);

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    isBound,
    parameters,
    returnType,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseFunction(el: XmlElement, namespace: string): ODataFunction {
  const name = str(el['@_Name']) || '';
  const isBound = str(el['@_IsBound']) === 'true';
  const parameters = parseParameters(el, isBound);
  const returnType = parseReturnType(el);
  const annotations = parseAnnotations(el);

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    isBound,
    parameters,
    returnType,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseParameters(el: XmlElement, isBound: boolean): ODataParameter[] {
  const parameters: ODataParameter[] = [];
  const paramElements = childElements(el, 'Parameter', 'edm');
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
  const returnTypes = childElements(el, 'ReturnType', 'edm');
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
  container?: string,
): ODataFunctionImport | null {
  const name = str(funcImport['@_Name']);
  if (!name) return null;

  const functionName = str(funcImport['@_Function']) || '';
  const entitySet = str(funcImport['@_EntitySet']) || undefined;
  const def = functionDefs.get(shortName(functionName));

  const parameters = parseParameters(funcImport, false);
  const returnType = def?.returnType;
  const effectiveParams = parameters.length > 0 ? parameters : def ? def.parameters : [];
  const annotations = parseAnnotations(funcImport);

  return {
    name,
    functionName: shortName(functionName) || functionName,
    qualifiedFunctionName: def?.qualifiedName || functionName || undefined,
    entitySet,
    container,
    parameter: effectiveParams.length > 0 ? effectiveParams : undefined,
    returnType,
    isBound: def?.isBound,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseEnumType(el: XmlElement, namespace: string): ODataEnumType | null {
  const name = str(el['@_Name']);
  if (!name) return null;

  const members: ODataEnumMember[] = [];
  for (const memberEl of childElements(el, 'Member', 'edm')) {
    const memberName = str(memberEl['@_Name']);
    if (!memberName) continue;
    let value: string | undefined;
    for (const attr of MEMBER_VALUE_ATTRS) {
      if (memberEl[attr] !== undefined) {
        value = str(memberEl[attr]);
        break;
      }
    }
    const memberAnnotations = parseAnnotations(memberEl);
    members.push({
      name: memberName,
      value,
      label: labelFromAnnotations(memberAnnotations),
      annotations: memberAnnotations,
    });
  }

  const annotations = parseAnnotations(el);
  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    underlyingType: str(el['@_UnderlyingType']) || undefined,
    members,
    label: labelFromAnnotations(annotations),
    annotations,
  };
}

function parseTypeDefinition(el: XmlElement, namespace: string): ODataTypeDefinition | null {
  const name = str(el['@_Name']);
  const underlyingType = str(el['@_UnderlyingType']);
  if (!name || !underlyingType) return null;
  const annotations = parseAnnotations(el);

  return {
    name,
    qualifiedName: qualify(namespace, name),
    namespace,
    underlyingType,
    label: labelFromAnnotations(annotations),
    annotations,
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

  const keyElements = childElements(entityType, 'Key', 'edm');
  for (const key of keyElements) {
    const propertyRefs = childElements(key, 'PropertyRef', 'edm');
    for (const propRef of propertyRefs) {
      const keyName = str(propRef['@_Name']);
      if (keyName) {
        keys.push(keyName);
      }
    }
  }

  const propElements = childElements(entityType, 'Property', 'edm');
  for (const prop of propElements) {
    properties.push(parseProperty(prop, keys));
  }

  const navPropElements = childElements(entityType, 'NavigationProperty', 'edm');
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

  const propElements = childElements(complexType, 'Property', 'edm');
  for (const prop of propElements) {
    properties.push(parseProperty(prop, []));
  }

  const navPropElements = childElements(complexType, 'NavigationProperty', 'edm');
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

  const ends = childElements(association, 'End', 'edm');
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

  return {
    // The reference as written: qualified when the document qualifies it
    // (`A.Part`), the short name otherwise. `shortName` used to throw the
    // namespace away here, leaving consumers to guess between same-named types.
    entity: type,
    entityQualified: type && type.includes('.') ? type : undefined,
    role,
    multiplicity,
  };
}

function parseAnnotations(el: XmlElement): Record<string, string> | undefined {
  const annElements = childElements(el, 'Annotation', 'edm');
  const out: Record<string, string> = {};
  for (const ann of annElements) {
    const term = str(ann['@_Term']);
    if (!term) continue;
    // A qualifier distinguishes multiple applications of the same term
    // (CSDL 4.01 §14.2.1). The model stores annotations as a
    // `Record<term, string>` and cannot represent it, so a qualified
    // annotation is rejected rather than flattened into the unqualified map.
    if (str(ann['@_Qualifier'])) continue;
    // `Term="Core.Description#Phone"` is the other spelling of a qualifier. It
    // is non-conformant for XML CSDL — the qualifier has its own attribute —
    // but it reached the map under a mangled key while the canonical spelling
    // was rejected, so the policy was not the complete one it claimed.
    if (term.includes('#')) continue;
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

  const collection = childElements(ann, 'Collection', 'edm')[0];
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
  // Reads both spellings, but deliberately not through `childElements`: that
  // helper is element-oriented and goes via `ensureArray`, which yields `[]`
  // for a primitive. A text-only leaf is handed back as a plain string, so
  // routing it through `childElements` dropped every singly-occurring
  // `<String>`, `<Bool>` or one-item `<Collection>` — the common case, and
  // silently, because repeated children still arrived as an array.
  const items: unknown[] = [];
  for (const [key, value] of Object.entries(el)) {
    if (key !== childName && key !== `edm:${childName}`) continue;
    if (Array.isArray(value)) {
      items.push(...(value as unknown[]));
    } else {
      items.push(value);
    }
  }
  if (items.length === 0) return undefined;
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

/**
 * Read an element under every spelling it may carry.
 *
 * XML allows the unprefixed and prefixed spellings of the same element to
 * coexist in one parent, and `a || b` returns only the first — so a document
 * mixing them silently loses a group, and nothing reports it. `isArray` does
 * not list most of these names, so a single occurrence arrives as an object and
 * repeats as an array; `ensureArray` normalises both.
 */
function childElements(owner: XmlElement, name: string, ...prefixes: string[]): XmlElement[] {
  // Walk the owner's own keys rather than reading each spelling in turn, so the
  // two spellings are interleaved rather than one being appended after the
  // other. Reading them in turn put every unprefixed element first, which moved
  // elements the document declared later — observable wherever first-wins
  // ordering is used, such as an unqualified annotation target resolved against
  // `findEntityByName`.
  //
  // `fast-xml-parser` groups repeats under one key, so this is the order of
  // groups rather than of individual elements, which is as much as the parsed
  // tree preserves. It also never pushes into `ensureArray`'s return value,
  // which is the caller's own array for a repeated element.
  const wanted = new Set([name, ...prefixes.map((prefix) => `${prefix}:${name}`)]);
  const elements: XmlElement[] = [];
  for (const [key, value] of Object.entries(owner)) {
    if (wanted.has(key)) elements.push(...ensureArray(value));
  }
  return elements;
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
