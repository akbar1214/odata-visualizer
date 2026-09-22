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
    | XmlElement
    | undefined;
  if (!dataServices) {
    throw new Error('Invalid OData CSDL: Missing DataServices element');
  }

  const schemas = ensureArray(dataServices['Schema'] || dataServices['edm:Schema'] || []);

  const version = str(edmx['@_Version']) || undefined;
  const entities: ODataEntity[] = [];
  const relationships: ODataRelationship[] = [];
  const functionImports: ODataFunctionImport[] = [];
  const actionImports: ODataActionImport[] = [];
  const entityContainers: ODataEntityContainer[] = [];

  for (const schema of schemas) {
    const namespace = str(schema['@_Namespace']) || '';
    const entityTypeNames = new Set<string>();

    const entityTypes = ensureArray(schema['EntityType'] || schema['edm:EntityType'] || []);
    for (const entityType of entityTypes) {
      const entity = parseEntityType(entityType, namespace);
      entityTypeNames.add(entity.name);
      entities.push(entity);
    }

    const complexTypes = ensureArray(schema['ComplexType'] || schema['edm:ComplexType'] || []);
    for (const complexType of complexTypes) {
      entities.push(parseComplexType(complexType, namespace));
    }

    const associations = ensureArray(schema['Association'] || schema['edm:Association'] || []);
    for (const association of associations) {
      const rel = parseAssociation(association, namespace);
      if (rel) {
        relationships.push(rel);
      }
    }

    const functionDefs = new Map<string, string>();
    const functions = ensureArray(schema['Function'] || schema['edm:Function'] || []);
    for (const func of functions) {
      const funcName = str(func['@_Name']) || '';
      const returnType = (func['ReturnType'] || func['edm:ReturnType']) as XmlElement | undefined;
      if (funcName && returnType) {
        const returnTypeStr = str(returnType['@_Type']) || '';
        if (returnTypeStr) {
          functionDefs.set(funcName, returnTypeStr);
        }
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
        const ai = parseActionImport(actionImport);
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

  return {
    version,
    entities,
    relationships,
    entityContainers,
    functionImports,
    actionImports,
  };
}

function relationshipFromNavigationProperty(
  entity: ODataEntity,
  nav: ODataNavigationProperty,
  namespace: string,
): ODataRelationship | null {
  if (!nav.targetType) return null;
  const isCollection = nav.relationship === 'Collection';
  return {
    name: nav.relationship || `${entity.name}_${nav.name}`,
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

  const entityType = rawType.includes('.') ? rawType.split('.').pop() || rawType : rawType;

  return {
    name,
    entityType,
    creatable: boolAttr(entitySet['@_Creatable']),
    updatable: boolAttr(entitySet['@_Updatable']),
    deletable: boolAttr(entitySet['@_Deletable']),
    navigable: boolAttr(entitySet['@_Navigable']),
  };
}

function parseActionImport(actionImport: XmlElement): ODataActionImport | null {
  const name = str(actionImport['@_Name']);
  if (!name) return null;

  const rawAction = str(actionImport['@_Action']) || '';
  const actionName = rawAction.includes('.') ? rawAction.split('.').pop() || rawAction : rawAction;
  const entitySet = str(actionImport['@_EntitySet']) || undefined;

  return { name, actionName, entitySet };
}

function parseEntityType(entityType: XmlElement, namespace: string): ODataEntity {
  const name = str(entityType['@_Name']) || '';
  const baseType = str(entityType['@_BaseType']) || undefined;
  const isAbstract = str(entityType['@_Abstract']) === 'true';
  const isOpenType = str(entityType['@_OpenType']) === 'true';

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
  const name = str(complexType['@_Name']) || '';
  const baseType = str(complexType['@_BaseType']) || undefined;
  const isOpenType = str(complexType['@_OpenType']) === 'true';

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
  const name = str(prop['@_Name']) || '';
  const type = str(prop['@_Type']) || 'Edm.String';
  const nullableValue = prop['@_Nullable'];
  const nullable = nullableValue !== false && nullableValue !== 'false';
  const maxLength = prop['@_MaxLength'] ? parseInt(String(prop['@_MaxLength']), 10) : undefined;
  const precision = prop['@_Precision'] ? parseInt(String(prop['@_Precision']), 10) : undefined;
  const scale = prop['@_Scale'] ? parseInt(String(prop['@_Scale']), 10) : undefined;

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
  const name = str(navProp['@_Name']) || '';
  const relationship = str(navProp['@_Relationship']) || '';
  const fromRole = str(navProp['@_FromRole']) || '';
  const toRole = str(navProp['@_ToRole']) || '';

  // OData V4: Type attribute holds the target entity type (possibly Collection(...)).
  // Store the collection flag in `relationship` so V4 relationship derivation
  // can compute multiplicity (V2 keeps the Association name there).
  const rawType = str(navProp['@_Type']) || '';
  let targetType: string | undefined;
  let isCollection = false;
  let derivedRelationship = relationship;
  if (rawType) {
    let typeStr = rawType;
    if (typeStr.startsWith('Collection(') && typeStr.endsWith(')')) {
      typeStr = typeStr.slice(11, -1);
      isCollection = true;
    }
    targetType = typeStr.includes('.') ? typeStr.split('.').pop() || typeStr : typeStr;
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
  const entity = type.includes('.') ? type.split('.').pop() || '' : type;

  return {
    entity,
    role,
    multiplicity,
  };
}

function parseFunctionImport(
  funcImport: XmlElement,
  functionDefs: Map<string, string>,
): ODataFunctionImport | null {
  const name = str(funcImport['@_Name']);
  if (!name) return null;

  const functionName = str(funcImport['@_Function']) || '';
  const entitySet = str(funcImport['@_EntitySet']) || undefined;

  let returnType: string | undefined;
  if (functionName) {
    const shortFuncName = functionName.includes('.')
      ? functionName.split('.').pop() || functionName
      : functionName;
    returnType = functionDefs.get(shortFuncName);
  }

  const parameters: ODataParameter[] = [];
  const paramElements = ensureArray(funcImport['Parameter'] || funcImport['edm:Parameter'] || []);
  for (const param of paramElements) {
    const paramName = str(param['@_Name']) || '';
    const paramType = str(param['@_Type']) || 'Edm.String';
    const nullable = str(param['@_Nullable']) !== 'false';
    const maxLength = param['@_MaxLength'] ? parseInt(String(param['@_MaxLength']), 10) : undefined;

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
  return String(value);
}

function boolAttr(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}
