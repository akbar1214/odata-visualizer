import { XMLParser, type X2jOptions } from 'fast-xml-parser';
import { readFile } from 'fs/promises';
import type {
  ODataMetadata,
  ODataEntity,
  ODataProperty,
  ODataRelationship,
  ODataAssociationEnd,
  ODataNavigationProperty,
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
      'FunctionImport',
      'ActionImport',
      'Parameter',
      'ReturnType',
    ].includes(name);
  },
};

const parser = new XMLParser(XML_PARSER_OPTIONS);

export interface MetadataSource {
  type: 'file' | 'url';
  path: string;
}

export async function loadMetadataFromSource(source: MetadataSource): Promise<ODataMetadata> {
  let xmlContent: string;

  if (source.type === 'file') {
    xmlContent = await readFile(source.path, 'utf-8');
  } else {
    const response = await fetch(source.path, {
      headers: { Accept: 'application/xml, text/xml, application/atomsvc+xml' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`);
    }

    xmlContent = await response.text();
  }

  return parseCSDL(xmlContent);
}

export async function parseCSDL(xmlContent: string): Promise<ODataMetadata> {
  if (!xmlContent || xmlContent.trim().length === 0) {
    throw new Error('XML content is empty');
  }

  let parsed: XmlElement;
  try {
    parsed = parser.parse(xmlContent) as XmlElement;
  } catch (error) {
    throw new Error(`Failed to parse XML: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

  for (const schema of schemas) {
    const namespace = schema['@_Namespace'] || '';

    const entityTypes = ensureArray(schema['EntityType'] || schema['edm:EntityType'] || []);
    for (const entityType of entityTypes) {
      entities.push(parseEntityType(entityType, namespace));
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
  }

  return {
    entities,
    relationships,
    entityContainers: [],
    functionImports: [],
    actionImports: [],
  };
}

function parseEntityType(entityType: XmlElement, namespace: string): ODataEntity {
  const name = entityType['@_Name'] || '';
  const baseType = entityType['@_BaseType'] || undefined;
  const isAbstract = entityType['@_Abstract'] === 'true';
  const isOpenType = entityType['@_OpenType'] === 'true';

  const keys: string[] = [];
  const properties: ODataProperty[] = [];
  const navigationProperties: ODataNavigationProperty[] = [];

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

  const propElements = ensureArray(entityType['Property'] || entityType['edm:Property'] || []);
  for (const prop of propElements) {
    properties.push(parseProperty(prop, keys));
  }

  const navPropElements = ensureArray(
    entityType['NavigationProperty'] || entityType['edm:NavigationProperty'] || []
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
  const name = complexType['@_Name'] || '';
  const baseType = complexType['@_BaseType'] || undefined;
  const isOpenType = complexType['@_OpenType'] === 'true';

  const properties: ODataProperty[] = [];

  const propElements = ensureArray(complexType['Property'] || complexType['edm:Property'] || []);
  for (const prop of propElements) {
    properties.push(parseProperty(prop, []));
  }

  return {
    name,
    namespace,
    baseType,
    abstract: false,
    openType: isOpenType,
    properties,
    navigationProperties: [],
    keys: [],
  };
}

function parseProperty(prop: XmlElement, keys: string[]): ODataProperty {
  const name = prop['@_Name'] || '';
  const type = prop['@_Type'] || 'Edm.String';
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
  const name = navProp['@_Name'] || '';
  const relationship = navProp['@_Relationship'] || '';
  const fromRole = navProp['@_FromRole'] || '';
  const toRole = navProp['@_ToRole'] || '';

  // OData V4: extract target entity type from Type attribute
  const rawType = navProp['@_Type'] || '';
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

function parseAssociationEnd(end: XmlElement): ODataAssociationEnd | null {
  const type = end['@_Type'] || '';
  const role = end['@_Role'] || '';
  const multiplicity = String(end['@_Multiplicity'] || '1');

  const entity = type.includes('.') ? type.split('.').pop() || '' : type;

  return {
    entity,
    role,
    multiplicity,
  };
}

function ensureArray(value: unknown): XmlElement[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    return [value as XmlElement];
  }
  return [];
}
