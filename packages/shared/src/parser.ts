import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import type {
  ODataMetadata,
  ODataEntity,
  ODataProperty,
  ODataRelationship,
  ODataAssociationEnd,
  ODataNavigationProperty,
  ODataFunctionImport,
  ODataActionImport,
  ODataEntityContainer,
  ODataEntitySet,
  ODataParameter,
} from './types.js';

type XmlElement = Record<string, unknown>;

const XML_PARSER_OPTIONS: X2jOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: true,
  parseAttributeValue: true,
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
      'ActionImport',
      'Parameter',
      'ReturnType',
    ].includes(name);
  },
};

const parser = new XMLParser(XML_PARSER_OPTIONS);

/**
 * Parse OData CSDL XML content into structured metadata
 */
export async function parseCSDL(xmlContent: string): Promise<ODataMetadata> {
  if (!xmlContent || xmlContent.trim().length === 0) {
    throw new Error('XML content is empty');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlContent) as Record<string, unknown>;
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
    | XmlElement
    | undefined;
  if (!dataServices) {
    throw new Error('Invalid OData CSDL: Missing DataServices element');
  }

  const schemas = ensureArray(dataServices, 'Schema', 'edm:Schema');

  const entities: ODataEntity[] = [];
  const relationships: ODataRelationship[] = [];
  const functionImports: ODataFunctionImport[] = [];
  const actionImports: ODataActionImport[] = [];
  const entityContainers: ODataEntityContainer[] = [];
  const collectionNavProps = new Map<string, boolean>();

  for (const schema of schemas) {
    const namespace = ensureStr(schema, '@_Namespace');

    const entityTypes = ensureArray(schema, 'EntityType', 'edm:EntityType');
    for (const entityType of entityTypes) {
      entities.push(parseEntityType(entityType, namespace, collectionNavProps));
    }

    const complexTypes = ensureArray(schema, 'ComplexType', 'edm:ComplexType');
    for (const complexType of complexTypes) {
      entities.push(parseComplexType(complexType, namespace));
    }

    const associations = ensureArray(schema, 'Association', 'edm:Association');
    for (const association of associations) {
      const rel = parseAssociation(association, namespace);
      if (rel) {
        relationships.push(rel);
      }
    }

    const functionDefs = new Map<string, string>();
    const functions = ensureArray(schema, 'Function', 'edm:Function');
    for (const func of functions) {
      const funcName = ensureStr(func, '@_Name');
      const returnType = ensureGet(func, 'ReturnType', 'edm:ReturnType') as XmlElement | undefined;
      if (funcName && returnType) {
        const returnTypeStr = ensureStr(returnType, '@_Type');
        if (returnTypeStr) {
          functionDefs.set(funcName, returnTypeStr);
        }
      }
    }

    const containers = ensureArray(schema, 'EntityContainer', 'edm:EntityContainer');
    for (const container of containers) {
      const containerName = ensureStr(container, '@_Name');
      const entitySets: ODataEntitySet[] = [];

      for (const entitySet of ensureArray(container, 'EntitySet', 'edm:EntitySet')) {
        const es = parseEntitySet(entitySet);
        if (es) {
          entitySets.push(es);
        }
      }

      if (containerName || entitySets.length > 0) {
        entityContainers.push({ name: containerName, entitySets });
      }

      for (const funcImport of ensureArray(container, 'FunctionImport', 'edm:FunctionImport')) {
        const fi = parseFunctionImport(funcImport, functionDefs);
        if (fi) {
          functionImports.push(fi);
        }
      }

      for (const actionImport of ensureArray(container, 'ActionImport', 'edm:ActionImport')) {
        const ai = parseActionImport(actionImport);
        if (ai) {
          actionImports.push(ai);
        }
      }
    }

    // Derive V4 relationships from navigation property target types
    for (const entity of entities) {
      if (entity.namespace !== namespace) continue;
      for (const nav of entity.navigationProperties) {
        if (!nav.targetType) continue;
        const alreadyExists = relationships.some(
          (rel) =>
            (rel.from.entity === entity.name && rel.to.entity === nav.targetType) ||
            (rel.from.entity === nav.targetType && rel.to.entity === entity.name),
        );
        if (alreadyExists) continue;

        const collection = collectionNavProps.get(`${entity.name}.${nav.name}`) === true;
        relationships.push({
          name: nav.relationship || `${entity.name}.${nav.name}`,
          namespace,
          from: { entity: entity.name, role: entity.name, multiplicity: '*' },
          to: {
            entity: nav.targetType,
            role: nav.targetType,
            multiplicity: collection ? '*' : '1',
          },
        });
      }
    }
  }

  return {
    version: ensureStr(edmx, '@_Version') || undefined,
    entities,
    relationships,
    entityContainers,
    functionImports,
    actionImports,
  };
}

function parseEntityType(
  entityType: XmlElement,
  namespace: string,
  collectionNavProps: Map<string, boolean>,
): ODataEntity {
  const name = ensureStr(entityType, '@_Name');
  const baseType = ensureStr(entityType, '@_BaseType') || undefined;
  const isAbstract = ensureStr(entityType, '@_Abstract') === 'true';
  const isOpenType = ensureStr(entityType, '@_OpenType') === 'true';

  const keys: string[] = [];
  const properties: ODataProperty[] = [];
  const navigationProperties: ODataNavigationProperty[] = [];

  for (const key of ensureArray(entityType, 'Key', 'edm:Key')) {
    for (const propRef of ensureArray(key, 'PropertyRef', 'edm:PropertyRef')) {
      const keyName = ensureStr(propRef, '@_Name');
      if (keyName) {
        keys.push(keyName);
      }
    }
  }

  for (const prop of ensureArray(entityType, 'Property', 'edm:Property')) {
    properties.push(parseProperty(prop, keys));
  }

  for (const navProp of ensureArray(entityType, 'NavigationProperty', 'edm:NavigationProperty')) {
    navigationProperties.push(parseNavigationProperty(navProp));
    collectionNavProps.set(
      `${name}.${ensureStr(navProp, '@_Name')}`,
      ensureStr(navProp, '@_Type').startsWith('Collection('),
    );
  }

  return {
    name,
    namespace,
    baseType,
    abstract: isAbstract,
    openType: isOpenType,
    properties,
    navigationProperties,
    keys,
  };
}

function parseComplexType(complexType: XmlElement, namespace: string): ODataEntity {
  const name = ensureStr(complexType, '@_Name');
  const baseType = ensureStr(complexType, '@_BaseType') || undefined;
  const isOpenType = ensureStr(complexType, '@_OpenType') === 'true';

  const properties: ODataProperty[] = [];
  const navigationProperties: ODataNavigationProperty[] = [];

  for (const prop of ensureArray(complexType, 'Property', 'edm:Property')) {
    properties.push(parseProperty(prop, []));
  }

  for (const navProp of ensureArray(
    complexType,
    'NavigationProperty',
    'edm:NavigationProperty',
  )) {
    navigationProperties.push(parseNavigationProperty(navProp));
  }

  return {
    name,
    namespace,
    baseType,
    abstract: false,
    openType: isOpenType,
    properties,
    navigationProperties,
    keys: [],
  };
}

function parseProperty(prop: XmlElement, keys: string[]): ODataProperty {
  const name = ensureStr(prop, '@_Name');
  const type = ensureStr(prop, '@_Type') || 'Edm.String';
  const rawNullable = ensureGet(prop, '@_Nullable');
  const nullable = rawNullable !== false && rawNullable !== 'false';
  const rawMaxLength = ensureGet(prop, '@_MaxLength');
  const rawPrecision = ensureGet(prop, '@_Precision');
  const rawScale = ensureGet(prop, '@_Scale');
  const maxLength = rawMaxLength !== undefined ? parseInt(String(rawMaxLength), 10) : undefined;
  const precision = rawPrecision !== undefined ? parseInt(String(rawPrecision), 10) : undefined;
  const scale = rawScale !== undefined ? parseInt(String(rawScale), 10) : undefined;

  return {
    name,
    type,
    nullable,
    maxLength,
    precision,
    scale,
    isKey: keys.includes(name),
  };
}

function parseNavigationProperty(navProp: XmlElement): ODataNavigationProperty {
  const name = ensureStr(navProp, '@_Name');
  const relationship = ensureStr(navProp, '@_Relationship');
  const fromRole = ensureStr(navProp, '@_FromRole');
  const toRole = ensureStr(navProp, '@_ToRole');

  // OData V4: extract target entity type from Type attribute
  // e.g., "Collection(NorthwindModel.Product)" -> "Product"
  const rawType = ensureStr(navProp, '@_Type');
  let targetType: string | undefined;
  if (rawType) {
    let typeStr = rawType;
    if (typeStr.startsWith('Collection(') && typeStr.endsWith(')')) {
      typeStr = typeStr.slice(11, -1);
    }
    if (typeStr.includes('.')) {
      targetType = typeStr.split('.').pop() || typeStr;
    } else {
      targetType = typeStr;
    }
  }

  return {
    name,
    relationship,
    fromRole,
    toRole,
    targetType,
  };
}

function parseAssociation(association: XmlElement, namespace: string): ODataRelationship | null {
  const name = ensureStr(association, '@_Name');
  if (!name) return null;

  const ends = ensureArray(association, 'End', 'edm:End');
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
  const type = ensureStr(end, '@_Type');
  const role = ensureStr(end, '@_Role');
  const multiplicity = String(ensureStr(end, '@_Multiplicity') || '1');

  const entity = type.includes('.') ? type.split('.').pop() || '' : type;

  return {
    entity,
    role,
    multiplicity,
  };
}

function parseEntitySet(entitySet: XmlElement): ODataEntitySet | null {
  const name = ensureStr(entitySet, '@_Name');
  if (!name) return null;

  const rawType = ensureStr(entitySet, '@_EntityType');
  const entityType = rawType.includes('.') ? rawType.split('.').pop() || rawType : rawType;

  const toBool = (value: unknown): boolean | undefined => {
    if (value === undefined) return undefined;
    return value !== false && value !== 'false';
  };

  return {
    name,
    entityType,
    creatable: toBool(ensureGet(entitySet, '@_Creatable')),
    updatable: toBool(ensureGet(entitySet, '@_Updatable')),
    deletable: toBool(ensureGet(entitySet, '@_Deletable')),
    navigable: toBool(ensureGet(entitySet, '@_Navigable')),
  };
}

function parseFunctionImport(
  funcImport: XmlElement,
  functionDefs: Map<string, string>,
): ODataFunctionImport | null {
  const name = ensureStr(funcImport, '@_Name');
  if (!name) return null;

  const functionName = ensureStr(funcImport, '@_Function');
  const entitySet = ensureStr(funcImport, '@_EntitySet') || undefined;

  let returnType: string | undefined;
  if (functionName) {
    const shortFuncName = functionName.includes('.')
      ? functionName.split('.').pop() || functionName
      : functionName;
    returnType = functionDefs.get(shortFuncName);
  }

  const parameters: ODataParameter[] = [];
  for (const param of ensureArray(funcImport, 'Parameter', 'edm:Parameter')) {
    const paramName = ensureStr(param, '@_Name');
    const paramType = ensureStr(param, '@_Type') || 'Edm.String';
    const nullable = ensureStr(param, '@_Nullable') !== 'false';
    const rawMaxLength = ensureGet(param, '@_MaxLength');
    const maxLength =
      rawMaxLength !== undefined ? parseInt(String(rawMaxLength), 10) : undefined;

    if (paramName) {
      parameters.push({
        name: paramName,
        type: paramType,
        nullable,
        maxLength,
      });
    }
  }

  return {
    name,
    functionName,
    entitySet,
    parameter: parameters.length > 0 ? parameters : undefined,
    returnType,
  };
}

function parseActionImport(actionImport: XmlElement): ODataActionImport | null {
  const name = ensureStr(actionImport, '@_Name');
  if (!name) return null;

  const rawAction = ensureStr(actionImport, '@_Action');
  const actionName = rawAction.includes('.') ? rawAction.split('.').pop() || rawAction : rawAction;
  const entitySet = ensureStr(actionImport, '@_EntitySet') || undefined;

  return {
    name,
    actionName,
    entitySet,
  };
}

function ensureGet(element: XmlElement, ...keys: string[]): unknown {
  for (const key of keys) {
    if (element[key] !== undefined) return element[key];
  }
  return undefined;
}

function ensureStr(element: XmlElement, ...keys: string[]): string {
  const value = ensureGet(element, ...keys);
  return value === undefined || value === null ? '' : String(value);
}

function ensureArray(element: XmlElement | undefined, ...keys: string[]): XmlElement[] {
  if (!element) return [];
  let value: unknown;
  for (const key of keys) {
    if (element[key] !== undefined) {
      value = element[key];
      break;
    }
  }
  if (Array.isArray(value)) {
    return value as XmlElement[];
  }
  if (value && typeof value === 'object') {
    return [value as XmlElement];
  }
  return [];
}
