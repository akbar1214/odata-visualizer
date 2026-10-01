/**
 * Traversal graph over parsed OData metadata.
 *
 * The graph has two kinds of edges, and they are **not** interchangeable:
 *
 * - `nav` — a navigation property. It renders as an `$expand` segment.
 * - `boundFunction` — a bound function whose binding parameter resolves to one
 *   entity type and whose return type resolves to another. It renders as a
 *   resource-path *segment* (`As('1')/N.B(...)`), never as `$expand`.
 *
 * The discriminated union is deliberate. The previous frontend pathfinder
 * walked `getEffectiveNavigationProperties` only, and `metadata.relationships`
 * is populated from `NavigationProperty`/`Association` elements only, so a
 * bound function — which the parser records in full — produced no route at all.
 *
 * Bound **actions** are out of scope: an action is not addressable in a GET
 * resource path, so it cannot be traversed through. Only functions form edges.
 */
import type { ODataEntity, ODataMetadata, ODataParameter } from './types.js';
import {
  findEntityByName,
  findTypeInScope,
  getEffectiveNavigationProperties,
  getEntitySelectionValue,
  getTargetEntityName,
} from './resolve.js';

/** A navigation-property step between two entity types. */
export interface TraversalNavEdge {
  kind: 'nav';
  /** Navigation property name. */
  name: string;
  /** Graph identity of the source entity (`A`, or `N.A` on a short-name collision). */
  from: string;
  /** Graph identity of the target entity. */
  to: string;
  /** Qualified target type when the property declares one. */
  targetType?: string;
}

/** A bound-function step between two entity types. */
export interface TraversalFunctionEdge {
  kind: 'boundFunction';
  /** Function simple name, e.g. `B`. */
  functionName: string;
  /** Namespace-qualified function name, e.g. `N.B`; distinguishes same-named functions and overloads. */
  qualifiedName: string;
  /** Graph identity of the entity the binding parameter resolves to. */
  from: string;
  /** Graph identity of the entity the return type resolves to. */
  to: string;
  /**
   * Parameters other than the binding one, in declaration order. A non-empty
   * list means the edge cannot be composed without user input — a caller that
   * cannot supply values must refuse the edge rather than emit a URL with a
   * missing parameter.
   */
  parameters: ODataParameter[];
  /** The binding parameter accepts a collection (`Collection(N.A)`). */
  bindingIsCollection: boolean;
  /** The return type is a collection (`Collection(N.C)`). */
  returnsCollection: boolean;
}

export type TraversalEdge = TraversalNavEdge | TraversalFunctionEdge;

/** Discriminate an operation edge from a navigation edge. */
export function isFunctionEdge(edge: TraversalEdge): edge is TraversalFunctionEdge {
  return edge.kind === 'boundFunction';
}

/**
 * Can this edge be rendered without additional user input? Navigation
 * properties always can; a bound function only when it has no parameters
 * beyond the binding one.
 */
export function isComposableEdge(edge: TraversalEdge): boolean {
  return edge.kind === 'nav' || edge.parameters.length === 0;
}

/** A single step along a traversal path. */
export interface TraversalStep {
  /** Graph identity of the source entity. */
  from: string;
  /** Graph identity of the target entity. */
  to: string;
  edge: TraversalEdge;
}

export type TraversalPath = TraversalStep[];

interface UnwrappedType {
  type: string;
  isCollection: boolean;
}

/** Split `Collection(X)` into its element type and a flag; leave other types alone. */
function unwrapCollection(type: string | undefined): UnwrappedType | undefined {
  if (!type) return undefined;
  const match = /^Collection\((.*)\)$/.exec(type);
  return match ? { type: match[1], isCollection: true } : { type, isCollection: false };
}

/**
 * Resolve a type reference to an entity, or `undefined` when it names a
 * primitive, a complex type, an unresolved reference, or nothing at all.
 *
 * The function's own namespace is passed as the scope hint: a sloppy document
 * that writes a bare `A` in a model with two `A` types must bind to its own
 * namespace's `A`, and an alias that the parser could not expand (because it
 * belongs to another document) resolves to nothing rather than to a stranger.
 */
function resolveEntityType(
  type: string,
  namespace: string | undefined,
  entities: ODataEntity[],
): ODataEntity | undefined {
  if (type.startsWith('Edm.')) return undefined;
  const entity = findTypeInScope(entities, type, namespace);
  return entity && entity.kind !== 'complex' ? entity : undefined;
}

/**
 * Every edge in the model: navigation properties first (document order), then
 * bound functions.
 *
 * Nav edges are derived per entity so inherited navigation properties are
 * traversable from each derived type under that type's own identity.
 */
export function getTraversalEdges(metadata: ODataMetadata): TraversalEdge[] {
  const edges: TraversalEdge[] = [];

  for (const entity of metadata.entities) {
    if (entity.kind === 'complex') continue;
    const from = getEntitySelectionValue(entity, metadata.entities);
    for (const nav of getEffectiveNavigationProperties(entity, metadata.entities)) {
      const targetName = getTargetEntityName(nav.name, entity, metadata);
      if (!targetName) continue;
      const target = findEntityByName(metadata.entities, targetName);
      if (!target || target.kind === 'complex') continue;
      edges.push({
        kind: 'nav',
        name: nav.name,
        from,
        to: getEntitySelectionValue(target, metadata.entities),
        targetType: nav.targetTypeQualified ?? nav.targetType,
      });
    }
  }

  for (const fn of metadata.functions) {
    if (!fn.isBound) continue;

    const binding = (fn.parameters ?? []).find((p) => p.isBinding);
    if (!binding) continue;
    const bindingType = unwrapCollection(binding.type);
    if (!bindingType) continue;
    const source = resolveEntityType(bindingType.type, fn.namespace, metadata.entities);
    if (!source) continue;

    const returnType = unwrapCollection(fn.returnType);
    if (!returnType) continue;
    const target = resolveEntityType(returnType.type, fn.namespace, metadata.entities);
    if (!target) continue;

    edges.push({
      kind: 'boundFunction',
      functionName: fn.name,
      qualifiedName: fn.qualifiedName ?? fn.name,
      from: getEntitySelectionValue(source, metadata.entities),
      to: getEntitySelectionValue(target, metadata.entities),
      parameters: (fn.parameters ?? []).filter((p) => !p.isBinding),
      bindingIsCollection: bindingType.isCollection,
      returnsCollection: returnType.isCollection,
    });
  }

  return edges;
}

/** The identity an entity name resolves to, falling back to the name itself. */
function identityOf(name: string, metadata: ODataMetadata): string {
  const entity = findEntityByName(metadata.entities, name);
  return entity ? getEntitySelectionValue(entity, metadata.entities) : name;
}

/** Successor edges indexed by source identity (lower-cased), built once per traversal. */
function buildSuccessorIndex(metadata: ODataMetadata): Map<string, TraversalEdge[]> {
  const index = new Map<string, TraversalEdge[]>();
  for (const edge of getTraversalEdges(metadata)) {
    const key = edge.from.toLowerCase();
    const list = index.get(key);
    if (list) list.push(edge);
    else index.set(key, [edge]);
  }
  return index;
}

function successorsOf(entityName: string, index: Map<string, TraversalEdge[]>): TraversalEdge[] {
  return index.get(entityName.toLowerCase()) ?? [];
}

/** Edges leaving one entity, addressed by short or qualified name. */
export function getSuccessorEdges(entityName: string, metadata: ODataMetadata): TraversalEdge[] {
  return successorsOf(entityName, buildSuccessorIndex(metadata));
}

/**
 * Bounded depth-first search for paths from one entity to another.
 *
 * Cycles are cut by the visited set, so a function whose return type equals its
 * binding type cannot loop. The search stops at the target: paths do not
 * continue through it.
 */
export function findPaths(
  sourceEntity: string,
  targetEntity: string,
  metadata: ODataMetadata,
  maxDepth: number = 5,
): TraversalPath[] {
  const sourceIdentity = identityOf(sourceEntity, metadata);
  const targetIdentity = identityOf(targetEntity, metadata);
  const index = buildSuccessorIndex(metadata);
  const paths: TraversalPath[] = [];
  const visited = new Set<string>([sourceIdentity.toLowerCase()]);

  const dfs = (currentEntity: string, path: TraversalPath, depth: number) => {
    if (depth > maxDepth) return;

    if (currentEntity.toLowerCase() === targetIdentity.toLowerCase() && path.length > 0) {
      paths.push([...path]);
      return;
    }

    for (const edge of successorsOf(currentEntity, index)) {
      const key = edge.to.toLowerCase();
      if (visited.has(key)) continue;

      visited.add(key);
      path.push({ from: edge.from, to: edge.to, edge });
      dfs(edge.to, path, depth + 1);
      path.pop();
      visited.delete(key);
    }
  };

  dfs(sourceIdentity, [], 0);
  return paths;
}

/**
 * Every entity reachable from `entityName` within `maxDepth`, keyed by the
 * source identity of each hop, with the steps that leave it.
 *
 * The visited set is keyed by edge, not by node, so a node reachable through
 * two different edges is reported through both — matching the previous
 * frontend walk.
 */
export function getReachableEntities(
  entityName: string,
  metadata: ODataMetadata,
  maxDepth: number = 4,
): Map<string, TraversalStep[]> {
  const result = new Map<string, TraversalStep[]>();
  const index = buildSuccessorIndex(metadata);
  const visited = new Set<string>();
  const queue: Array<{ entityName: string; depth: number }> = [
    { entityName: identityOf(entityName, metadata), depth: 0 },
  ];

  while (queue.length > 0) {
    const { entityName: currentName, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const steps: TraversalStep[] = [];
    for (const edge of successorsOf(currentName, index)) {
      steps.push({ from: edge.from, to: edge.to, edge });

      const key = `${edge.from.toLowerCase()}->${edge.to.toLowerCase()}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ entityName: edge.to, depth: depth + 1 });
      }
    }

    if (steps.length > 0) {
      const existing = result.get(currentName) ?? [];
      result.set(currentName, [...existing, ...steps]);
    }
  }

  return result;
}
