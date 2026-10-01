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

/** Shared empty table, so a document with no aliases needs no allocation. */
const EMPTY_ALIASES: Map<string, string> = new Map();

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
  namespaces: Set<string>,
): void {
  /**
   * Expansion is per element, not global: an alias is only valid inside the
   * document that declares it, so each element resolves against its own
   * document's table.
   */
  const expanderFor =
    (namespace: string | undefined, element?: object) =>
    (value: string | undefined): string | undefined =>
      value === undefined
        ? undefined
        : expandAlias(value, aliasesForNamespace(namespace, element), namespaces);

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

  const registerSchema = (schema: XmlElement, document: number): void => {
    const namespace = str(schema['@_Namespace']);
    if (!namespace || registry.has(namespace)) return;
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
        if (!unresolvedReferences.includes(uri)) unresolvedReferences.push(uri);
      }
    }
  };

  await loadReferences(rootDocument.references, nextDocumentId);

  // Model-global, matching #25. CSDL aliases are document-local, so a document
  // that declares an alias equal to a *different* document's namespace does not
  // get that alias expanded here. Scoping this set per document is a behaviour
  // change that belongs with the rest of the #25 work — tracked in #28.
  const registeredNamespaces = new Set(registry.keys());
  const aliasesForNamespace = (
    namespace?: string,
    element?: object,
    document?: number,
  ): Map<string, string> => {
    const resolved =
      (element !== undefined ? documentOfElement.get(element) : undefined) ??
      document ??
      (namespace ? documentOfNamespace.get(namespace) : undefined) ??
      0;
    return aliasesByDocument.get(resolved) ?? EMPTY_ALIASES;
  };

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
      if (containerName || parsedEntitySets.length > 0) {
        entityContainers.push({ name: containerName, namespace, entitySets: parsedEntitySets });
      }

      const funcImports = childElements(container, 'FunctionImport', 'edm');
      for (const funcImport of funcImports) {
        const fi = parseFunctionImport(funcImport, functionDefs);
        if (fi) {
          documentOfElement.set(fi, currentDocument);
          functionImports.push(fi);
        }
      }

      const actImports = childElements(container, 'ActionImport', 'edm');
      for (const actionImport of actImports) {
        const ai = parseActionImport(actionImport, actionDefs);
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
          expandAlias(v, aliasesForNamespace(namespace), registeredNamespaces),
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

  expandAliasesInMetadata(metadata, aliasesForNamespace, registeredNamespaces);
  applyTargetedAnnotations(
    metadata,
    targetedAnnotations,
    aliasesForNamespace,
    registeredNamespaces,
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
 * - A bare target (no dot in its first segment) resolves in the schema that
 *   declared the block first, then across the model. Every lookup is exact-case
 *   first with a case-insensitive fallback, per the project-wide case policy.
 * - A block carrying `Qualifier` is rejected: `annotations` is a
 *   `Record<term, string>` and cannot represent the qualifier, so attaching
 *   either value as if it were unqualified would be silently wrong.
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
  namespaces: Set<string>,
): void {
  // Inline annotations win over targeted ones. Snapshot which terms each
  // element declared inline *before* any block is applied, so a later block
  // cannot overwrite one and a bare target cannot win by arriving first.
  const inlineTerms = new WeakMap<object, Set<string>>();
  const rememberInline = (element: { annotations?: Record<string, string> }) => {
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
    for (const set of container.entitySets) rememberInline(set);
  }

  const applyTo = (
    element: { annotations?: Record<string, string>; label?: string },
    extra: Record<string, string>,
  ): void => {
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

  for (const block of targeted) {
    // Rejected on purpose. The combination of target, term and qualifier
    // uniquely identifies an annotation (CSDL 4.01 §14.2.1), and `annotations`
    // cannot carry the qualifier, so a qualified block is dropped rather than
    // flattened into the unqualified map. No consumer acts on a qualifier yet;
    // revisit when one does.
    if (block.qualifier) continue;

    // The namespace guard added in #25 matters here too: a prefix that names an
    // actual schema is a namespace, not an alias, so an annotation target
    // cannot be rewritten into another document's namespace.
    const expanded = expandAlias(
      block.target,
      aliasesForNamespace(undefined, undefined, block.document),
      namespaces,
    );
    const segments = expanded.split('/');

    // `NS.Type/Prop`. Per CSDL a schema child must be namespace-qualified, so
    // an unqualified first segment cannot be a type — requiring the dot keeps
    // `C/Widgets` from matching a property named `Widgets` on some type `C`.
    if (segments.length === 2 && segments[0].includes('.')) {
      const owner = findTypeInScope(metadata.entities, segments[0], block.namespace);
      if (owner) {
        // Annotations apply to structural *or* navigation properties.
        const property = findPropertyOrNavigation(owner, segments[1]);
        if (property) {
          applyTo(property, block.annotations);
          continue;
        }
      }
    }

    // `NS.Container/Set` — the spec form, and what `odata-demo-metadata.xml`
    // uses (`ODataDemo.DemoService/Suppliers`). The unqualified `Container/Set`
    // is accepted too, because it costs nothing and appears in hand-written
    // documents.
    if (segments.length === 2) {
      const container = findContainer(metadata.entityContainers, segments[0], block.namespace);
      const set = container ? findSetIn(container, segments[1]) : undefined;
      if (set) {
        applyTo(set, block.annotations);
        continue;
      }
    }

    if (segments.length === 1) {
      // A type, or a container-less entity set name.
      const entity = findTypeInScope(metadata.entities, expanded, block.namespace);
      if (entity) {
        applyTo(entity, block.annotations);
        continue;
      }
      const set = findEntitySetInScope(metadata, expanded, block.namespace);
      if (set) {
        applyTo(set, block.annotations);
      }
    }
  }
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
): ODataProperty | ODataNavigationProperty | undefined {
  const exact =
    owner.properties.find((property) => property.name === name) ??
    owner.navigationProperties.find((navigation) => navigation.name === name);
  if (exact) return exact;

  const needle = name.toLowerCase();
  return (
    owner.properties.find((property) => property.name.toLowerCase() === needle) ??
    owner.navigationProperties.find((navigation) => navigation.name.toLowerCase() === needle)
  );
}

/**
 * A container by bare or namespace-qualified name, preferring the schema that
 * declared the annotation block. Exact case first, then case-insensitive.
 */
function findContainer(
  containers: ODataEntityContainer[],
  name: string,
  preferredNamespace: string,
): ODataEntityContainer | undefined {
  const qualified = (container: ODataEntityContainer) =>
    container.namespace ? `${container.namespace}.${container.name}` : container.name;

  const exactQualified = containers.find(
    (container) => container.namespace && qualified(container) === name,
  );
  if (exactQualified) return exactQualified;

  const exactSameNamespace = containers.find(
    (container) => container.namespace === preferredNamespace && container.name === name,
  );
  if (exactSameNamespace) return exactSameNamespace;

  const exactBare = containers.find((container) => container.name === name);
  if (exactBare) return exactBare;

  const needle = name.toLowerCase();
  return (
    containers.find(
      (container) => container.namespace && qualified(container).toLowerCase() === needle,
    ) ??
    containers.find(
      (container) =>
        container.namespace?.toLowerCase() === preferredNamespace.toLowerCase() &&
        container.name.toLowerCase() === needle,
    ) ??
    containers.find((container) => container.name.toLowerCase() === needle)
  );
}

/** An entity set within one container. Exact case first, then case-insensitive. */
function findSetIn(container: ODataEntityContainer, name: string): ODataEntitySet | undefined {
  const exact = container.entitySets.find((set) => set.name === name);
  if (exact) return exact;
  const needle = name.toLowerCase();
  return container.entitySets.find((set) => set.name.toLowerCase() === needle);
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
