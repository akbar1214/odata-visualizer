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
  label?: string;
  annotations?: Record<string, string>;
}

/** Entity type definition */
export interface ODataEntity {
  name: string;
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

/** Entity set definition */
export interface ODataEntitySet {
  name: string;
  entityType: string;
  label?: string;
  creatable?: boolean;
  updatable?: boolean;
  deletable?: boolean;
  navigable?: boolean;
  annotations?: Record<string, string>;
}

/** Function import */
export interface ODataFunctionImport {
  name: string;
  functionName: string;
  entitySet?: string;
  parameter?: ODataParameter[];
  annotations?: Record<string, string>;
}

/** Action import */
export interface ODataActionImport {
  name: string;
  actionName: string;
  entitySet?: string;
  annotations?: Record<string, string>;
}

/** Parameter for function/action */
export interface ODataParameter {
  name: string;
  type: string;
  nullable?: boolean;
  maxLength?: number;
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
