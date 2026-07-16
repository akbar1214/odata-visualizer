import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import type {
  ODataMetadata,
  ODataEntity,
  ODataProperty,
  ODataRelationship,
  ODataAssociationEnd,
  ODataNavigationProperty,
  ODataFunctionImport,
  ODataParameter,
} from '@odata-visualizer/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlElement = Record<string, any>;

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

  const edmx = parsed['edmx:Edmx'] || parsed['Edmx'];
  if (!edmx) {
    throw new Error('Invalid OData CSDL: Missing Edmx root element');
  }

  const dataServices = edmx['edmx:DataServices'] || edmx['DataServices'];
  if (!dataServices) {
    throw new Error('Invalid OData CSDL: Missing DataServices element');
  }

  const schemas = ensureArray(dataServices['Schema'] || dataServices['edm:Schema'] || []);

  const entities: ODataEntity[] = [];
  const relationships: ODataRelationship[] = [];
  const functionImports: ODataFunctionImport[] = [];

  for (const schema of schemas) {
    const namespace = schema['@_Namespace'] || '';

    // Parse entity types
    const entityTypes = ensureArray(schema['EntityType'] || schema['edm:EntityType'] || []);
    for (const entityType of entityTypes) {
      entities.push(parseEntityType(entityType, namespace));
    }

    // Parse complex types as entities
    const complexTypes = ensureArray(schema['ComplexType'] || schema['edm:ComplexType'] || []);
    for (const complexType of complexTypes) {
      entities.push(parseComplexType(complexType, namespace));
    }

    // Parse associations
    const associations = ensureArray(schema['Association'] || schema['edm:Association'] || []);
    for (const association of associations) {
      const rel = parseAssociation(association, namespace);
      if (rel) {
        relationships.push(rel);
      }
    }

    // Parse Function definitions to get return types
    const functionDefs = new Map<string, string>();
    const functions = ensureArray(schema['Function'] || schema['edm:Function'] || []);
    for (const func of functions) {
      const funcName = func['@_Name'] || '';
      const returnType = func['ReturnType'] || func['edm:ReturnType'];
      if (funcName && returnType) {
        const returnTypeStr = returnType['@_Type'] || '';
        if (returnTypeStr) {
          functionDefs.set(funcName, returnTypeStr);
        }
      }
    }

    // Parse function imports from EntityContainer
    const containers = ensureArray(
      schema['EntityContainer'] || schema['edm:EntityContainer'] || [],
    );
    for (const container of containers) {
      const funcImports = ensureArray(
        container['FunctionImport'] || container['edm:FunctionImport'] || [],
      );
      for (const funcImport of funcImports) {
        const fi = parseFunctionImport(funcImport, namespace, functionDefs);
        if (fi) {
          functionImports.push(fi);
        }
      }
    }
  }

  return {
    entities,
    relationships,
    entityContainers: [],
    functionImports,
    actionImports: [],
  };
}

/**
 * Parse an EntityType element
 */
function parseEntityType(entityType: XmlElement, namespace: string): ODataEntity {
  const name = entityType['@_Name'] || '';
  const baseType = entityType['@_BaseType'] || undefined;
  const isAbstract = entityType['@_Abstract'] === 'true';
  const isOpenType = entityType['@_OpenType'] === 'true';

  const keys: string[] = [];
  const properties: ODataProperty[] = [];
  const navigationProperties: ODataNavigationProperty[] = [];

  // Parse Key
  const keyElements = ensureArray(entityType['Key'] || entityType['edm:Key'] || []);
  for (const key of keyElements) {
    const propertyRefs = ensureArray(key['PropertyRef'] || key['edm:PropertyRef'] || []);
    for (const propRef of propertyRefs) {
      const keyName = propRef['@_Name'];
      if (keyName) {
        keys.push(keyName);
      }
    }
  }

  // Parse Properties
  const propElements = ensureArray(entityType['Property'] || entityType['edm:Property'] || []);
  for (const prop of propElements) {
    properties.push(parseProperty(prop, keys));
  }

  // Parse Navigation Properties
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

/**
 * Parse a ComplexType element
 */
function parseComplexType(complexType: XmlElement, namespace: string): ODataEntity {
  const name = complexType['@_Name'] || '';
  const baseType = complexType['@_BaseType'] || undefined;
  const isOpenType = complexType['@_OpenType'] === 'true';

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

/**
 * Parse a Property element
 */
function parseProperty(prop: XmlElement, keys: string[]): ODataProperty {
  const name = prop['@_Name'] || '';
  const type = prop['@_Type'] || 'Edm.String';
  // Handle both string "false" and boolean false from XML parser
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

/**
 * Parse a NavigationProperty element
 */
function parseNavigationProperty(navProp: XmlElement): ODataNavigationProperty {
  const name = navProp['@_Name'] || '';
  const relationship = navProp['@_Relationship'] || '';
  const fromRole = navProp['@_FromRole'] || '';
  const toRole = navProp['@_ToRole'] || '';

  // OData V4: extract target entity type from Type attribute
  // e.g., "Collection(NorthwindModel.Product)" -> "Product"
  // e.g., "NorthwindModel.Order" -> "Order"
  const rawType = navProp['@_Type'] || '';
  let targetType: string | undefined;
  if (rawType) {
    let typeStr = rawType;
    // Strip Collection() wrapper
    if (typeStr.startsWith('Collection(') && typeStr.endsWith(')')) {
      typeStr = typeStr.slice(11, -1);
    }
    // Extract entity name from namespace-qualified type
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

/**
 * Parse an Association element
 */
function parseAssociation(association: XmlElement, namespace: string): ODataRelationship | null {
  const name = association['@_Name'];
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

/**
 * Parse an Association End element
 */
function parseAssociationEnd(end: XmlElement): ODataAssociationEnd | null {
  const type = end['@_Type'] || '';
  const role = end['@_Role'] || '';
  // Ensure multiplicity is always a string (XML parser may convert "1" to number)
  const multiplicity = String(end['@_Multiplicity'] || '1');

  // Extract entity name from full type (e.g., "Namespace.EntityName" -> "EntityName")
  const entity = type.includes('.') ? type.split('.').pop() || '' : type;

  return {
    entity,
    role,
    multiplicity,
  };
}

/**
 * Parse a FunctionImport element
 */
function parseFunctionImport(
  funcImport: XmlElement,
  _namespace: string,
  functionDefs: Map<string, string>,
): ODataFunctionImport | null {
  const name = funcImport['@_Name'];
  if (!name) return null;

  const functionName = funcImport['@_Function'] || '';
  const entitySet = funcImport['@_EntitySet'] || undefined;

  // Look up return type from function definitions
  let returnType: string | undefined;
  if (functionName) {
    // Extract function name from full path (e.g., "Namespace.FunctionName" -> "FunctionName")
    const shortFuncName = functionName.includes('.')
      ? functionName.split('.').pop() || functionName
      : functionName;
    returnType = functionDefs.get(shortFuncName);
  }

  const parameters: ODataParameter[] = [];
  const paramElements = ensureArray(funcImport['Parameter'] || funcImport['edm:Parameter'] || []);
  for (const param of paramElements) {
    const paramName = param['@_Name'] || '';
    const paramType = param['@_Type'] || 'Edm.String';
    const nullable = param['@_Nullable'] !== 'false';
    const maxLength = param['@_MaxLength'] ? parseInt(param['@_MaxLength'], 10) : undefined;

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

/**
 * Ensure a value is an array
 */
function ensureArray(value: unknown): XmlElement[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    return [value as XmlElement];
  }
  return [];
}
