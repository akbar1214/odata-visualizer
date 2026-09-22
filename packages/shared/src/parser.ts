import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import { resolveInheritanceChain } from './resolve.js';
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

/**
 * Parse OData CSDL XML content into structured metadata
 */
export async function parseCSDL(xmlContent: string): Promise<ODataMetadata> {
  if (!xmlContent || xmlContent.trim().length === 0) {
    throw new Error('XML content is empty');
  }

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

  const version = str(edmx['@_Version']) || undefined;
  const dataServicesVersion =
    str(dataServices['@_m:DataServiceVersion']) ||
    str(dataServices['@_DataServiceVersion']) ||
    undefined;
  const entities: ODataEntity[] = [];
  const relationships: ODataRelationship[] = [];
  const functionImports: ODataFunctionImport[] = [];
  const actionImports: ODataActionImport[] = [];
  const entityContainers: ODataEntityContainer[] = [];
  const actions: ODataAction[] = [];
  const functions: ODataFunction[] = [];
  const enumTypes: ODataEnumType[] = [];
  const typeDefinitions: ODataTypeDefinition[] = [];

  for (const schema of schemas) {
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
        entityContainers.push({ name: containerName, entitySets: parsedEntitySets });
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
    // navigation properties with a Type (targetType) attribute.
    for (const entity of entities) {
      if (entity.namespace !== namespace || !entityTypeNames.has(entity.name)) {
        continue;
      }
      for (const nav of entity.navigationProperties) {
        if (!nav.targetType) continue;
        const rel = relationshipFromNavigationProperty(entity, nav, namespace);
        if (!rel) continue;
        const exists = relationships.some(
          (r) =>
            (r.from.entity === rel.from.entity && r.to.entity === rel.to.entity) ||
            (r.from.entity === rel.to.entity && r.to.entity === rel.from.entity),
        );
        if (!exists) {
          relationships.push(rel);
        }
      }
    }
  }

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

  return {
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
}

function relationshipFromNavigationProperty(
  entity: ODataEntity,
  nav: ODataNavigationProperty,
  namespace: string,
): ODataRelationship | null {
  if (!nav.targetType) return null;
  const isCollection = nav.relationship === 'Collection';
  const associationName =
    nav.relationship && nav.relationship !== 'Collection'
      ? nav.relationship
      : `${entity.name}_${nav.name}`;
  return {
    name: associationName,
    namespace,
    from: {
      entity: entity.name,
      role: nav.fromRole || entity.name,
      multiplicity: isCollection ? '*' : '1',
    },
    to: {
      entity: nav.targetType,
      role: nav.toRole || nav.targetType,
      multiplicity: isCollection ? '1' : '*',
    },
  };
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

  // OData V4: Type attribute holds the target entity type (possibly Collection(...)).
  // Store the collection flag in `relationship` so V4 relationship derivation
  // can compute multiplicity (V2 keeps the Association name there).
  const rawType = str(navProp['@_Type']) || '';
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
