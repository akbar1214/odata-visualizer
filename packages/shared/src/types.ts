/**
 * OData Visualizer - Shared Types
 *
 * Core type definitions for OData metadata parsing and visualization.
 */

/** OData property within an entity */
export interface ODataProperty {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isKey: boolean;
  label?: string;
  annotations?: Record<string, string>;
}

/** Navigation property connecting entities */
export interface ODataNavigationProperty {
  name: string;
  relationship: string;
  fromRole: string;
  toRole: string;
  targetType?: string;
  /** Fully qualified target type name when available */
  targetTypeQualified?: string;
  label?: string;
  annotations?: Record<string, string>;
}

/** Entity type definition */
export interface ODataEntity {
  name: string;
  /** Fully qualified name (namespace.Name) when a namespace is present */
  qualifiedName?: string;
  /** Whether this entry came from an EntityType or ComplexType element */
  kind?: 'entity' | 'complex';
  label?: string;
  namespace?: string;
  baseType?: string;
  abstract?: boolean;
  openType?: boolean;
  properties: ODataProperty[];
  navigationProperties: ODataNavigationProperty[];
  keys: string[];
  annotations?: Record<string, string>;
}

/** Association end */
export interface ODataAssociationEnd {
  entity: string;
  role: string;
  multiplicity: string;
}

/** Association/Relationship between entities */
export interface ODataRelationship {
  name: string;
  namespace?: string;
  from: ODataAssociationEnd;
  to: ODataAssociationEnd;
}

/** Entity container with entity sets */
export interface ODataEntityContainer {
  name: string;
  entitySets: ODataEntitySet[];
}

/** Navigation property binding on an entity set (V4) */
export interface ODataNavigationPropertyBinding {
  path: string;
  target: string;
}

/** Entity set definition */
export interface ODataEntitySet {
  name: string;
  entityType: string;
  /** Fully qualified entity type name when available */
  entityTypeQualified?: string;
  label?: string;
  creatable?: boolean;
  updatable?: boolean;
  deletable?: boolean;
  navigable?: boolean;
  navigationPropertyBindings?: ODataNavigationPropertyBinding[];
  annotations?: Record<string, string>;
}

/** Parameter for function/action */
export interface ODataParameter {
  name: string;
  type: string;
  nullable?: boolean;
  maxLength?: number;
  /** True for the binding parameter of a bound action/function */
  isBinding?: boolean;
}

/** Schema-level action definition */
export interface ODataAction {
  name: string;
  qualifiedName?: string;
  namespace?: string;
  isBound: boolean;
  parameters: ODataParameter[];
  returnType?: string;
  label?: string;
  annotations?: Record<string, string>;
}

/** Schema-level function definition */
export interface ODataFunction {
  name: string;
  qualifiedName?: string;
  namespace?: string;
  isBound: boolean;
  parameters: ODataParameter[];
  returnType?: string;
  label?: string;
  annotations?: Record<string, string>;
}

/** Enum type member */
export interface ODataEnumMember {
  name: string;
  value?: string;
}

/** Enum type definition */
export interface ODataEnumType {
  name: string;
  qualifiedName?: string;
  namespace?: string;
  underlyingType?: string;
  members: ODataEnumMember[];
  annotations?: Record<string, string>;
}

/** Type definition (custom EDM type) */
export interface ODataTypeDefinition {
  name: string;
  qualifiedName?: string;
  namespace?: string;
  underlyingType: string;
  annotations?: Record<string, string>;
}

/** Function import */
export interface ODataFunctionImport {
  name: string;
  functionName: string;
  qualifiedFunctionName?: string;
  entitySet?: string;
  parameter?: ODataParameter[];
  returnType?: string;
  isBound?: boolean;
  annotations?: Record<string, string>;
}

/** Action import */
export interface ODataActionImport {
  name: string;
  actionName: string;
  qualifiedActionName?: string;
  entitySet?: string;
  isBound?: boolean;
  parameter?: ODataParameter[];
  returnType?: string;
  annotations?: Record<string, string>;
}

/** Complete OData metadata */
export interface ODataMetadata {
  version?: string;
  dataServicesVersion?: string;
  entities: ODataEntity[];
  relationships: ODataRelationship[];
  entityContainers: ODataEntityContainer[];
  functionImports: ODataFunctionImport[];
  actionImports: ODataActionImport[];
  actions: ODataAction[];
  functions: ODataFunction[];
  enumTypes: ODataEnumType[];
  typeDefinitions: ODataTypeDefinition[];
  /** edmx:Reference targets that could not be loaded (no loader or fetch failed). */
  unresolvedReferences?: string[];
  annotations?: Record<string, unknown>;
}

/** Parse request from frontend */
export interface ParseRequest {
  type: 'file' | 'url';
  content?: string;
  url?: string;
  fileName?: string;
}

/** Parse response to frontend */
export interface ParseResponse {
  success: boolean;
  data?: ODataMetadata;
  error?: string;
  warnings?: string[];
  parseTimeMs: number;
  fileSizeBytes: number;
}

/** Diagram node for React Flow */
export interface DiagramNode {
  id: string;
  type: 'entity';
  position: { x: number; y: number };
  data: {
    entity: ODataEntity;
    selected?: boolean;
  };
}

/** Diagram edge for React Flow */
export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  type: 'relationship';
  data: {
    relationship: ODataRelationship;
    label?: string;
  };
}

/** Diagram state */
export interface DiagramState {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Application state */
export interface AppState {
  metadata: ODataMetadata | null;
  loading: boolean;
  error: string | null;
  parseTimeMs: number | null;
  fileSizeBytes: number | null;
  selectedEntity: string | null;
  diagramState: DiagramState;
}

/** Filter options for diagram */
export interface DiagramFilter {
  search?: string;
  namespaces?: string[];
  showRelationships?: boolean;
  showNavigationProperties?: boolean;
  maxEntities?: number;
}
