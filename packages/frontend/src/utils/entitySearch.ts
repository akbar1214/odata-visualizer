import type { ODataEntity, ODataMetadata } from '@odata-visualizer/shared';
import { getEffectiveNavigationProperties, getEffectiveProperties } from '@odata-visualizer/shared';

export interface EntityMatch {
  entity: ODataEntity;
  /** Lower is better. */
  score: number;
  /** Short human-readable reasons, e.g. `property: number`. */
  reasons: string[];
}

export interface SearchOptions {
  /** Match complex types too (default true). */
  includeComplexTypes?: boolean;
  /** Cap the number of results. */
  limit?: number;
}

/** Field weights: lower means a stronger match. */
const SCORE = {
  exactName: 0,
  namePrefix: 1,
  qualifiedPrefix: 2,
  nameContains: 3,
  qualifiedContains: 4,
  labelContains: 5,
  namespaceContains: 6,
  propertyContains: 7,
  navigationContains: 8,
  annotationContains: 9,
} as const;

interface IndexedEntity {
  entity: ODataEntity;
  name: string;
  qualifiedName: string;
  namespace: string;
  label: string;
  annotations: string;
  properties: string;
  navigations: string;
  /** Property/nav names that contain a token, for the "matched on" hint. */
  propertyNames: string[];
  navigationNames: string[];
  annotationValues: string[];
}

function annotationText(entity: ODataEntity): string {
  return Object.entries(entity.annotations ?? {})
    .map(([term, value]) => `${term} ${value}`)
    .join(' ');
}

/**
 * Build (and cache) the searchable text for one type. Inherited properties and
 * navigation properties are included, because a deep model is usually
 * searched by a property that lives on a base type.
 */
function indexEntity(entity: ODataEntity, entities: ODataEntity[]): IndexedEntity {
  const properties = getEffectiveProperties(entity, entities);
  const navigations = getEffectiveNavigationProperties(entity, entities);
  return {
    entity,
    name: entity.name.toLowerCase(),
    qualifiedName: (entity.qualifiedName ?? entity.name).toLowerCase(),
    namespace: (entity.namespace ?? '').toLowerCase(),
    label: (entity.label ?? '').toLowerCase(),
    annotations: annotationText(entity).toLowerCase(),
    properties: properties.map((p) => p.name.toLowerCase()).join(' '),
    navigations: navigations.map((n) => n.name.toLowerCase()).join(' '),
    propertyNames: properties.map((p) => p.name.toLowerCase()),
    navigationNames: navigations.map((n) => n.name.toLowerCase()),
    annotationValues: Object.values(entity.annotations ?? {}).map((v) => v.toLowerCase()),
  };
}

/** Split a query into tokens; every token must match something. */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function scoreToken(entry: IndexedEntity, token: string): { score: number; reason?: string } {
  if (entry.name === token) return { score: SCORE.exactName, reason: 'name' };
  if (entry.name.startsWith(token)) return { score: SCORE.namePrefix, reason: 'name' };
  if (entry.qualifiedName.startsWith(token)) {
    return { score: SCORE.qualifiedPrefix, reason: 'qualified name' };
  }
  if (entry.name.includes(token)) return { score: SCORE.nameContains, reason: 'name' };
  if (entry.qualifiedName.includes(token)) {
    return { score: SCORE.qualifiedContains, reason: 'qualified name' };
  }
  if (entry.label.includes(token)) return { score: SCORE.labelContains, reason: 'label' };
  if (entry.namespace.includes(token)) {
    return { score: SCORE.namespaceContains, reason: 'namespace' };
  }
  if (entry.properties.includes(token)) {
    const hit = entry.propertyNames.find((name) => name.includes(token));
    return { score: SCORE.propertyContains, reason: `property: ${hit}` };
  }
  if (entry.navigations.includes(token)) {
    const hit = entry.navigationNames.find((name) => name.includes(token));
    return { score: SCORE.navigationContains, reason: `navigation: ${hit}` };
  }
  if (entry.annotations.includes(token)) {
    const hit = entry.annotationValues.find((value) => value.includes(token));
    return { score: SCORE.annotationContains, reason: `description: ${hit}` };
  }
  return { score: Number.POSITIVE_INFINITY };
}

function scoreEntity(entry: IndexedEntity, tokens: string[]): EntityMatch | null {
  let total = 0;
  const reasons: string[] = [];

  for (const token of tokens) {
    const result = scoreToken(entry, token);
    if (!Number.isFinite(result.score)) return null;
    total += result.score;
    if (result.reason && !reasons.includes(result.reason)) reasons.push(result.reason);
  }

  // Prefer entity types over complex types at equal relevance.
  if (entry.entity.kind === 'complex') total += 0.5;
  return { entity: entry.entity, score: total, reasons };
}

/**
 * Create a reusable search function for a model. The per-type index is built
 * once and reused across keystrokes, which matters for Windchill-sized
 * models with thousands of types.
 */
export function createEntitySearch(metadata: ODataMetadata) {
  const cache = new Map<ODataEntity, IndexedEntity>();

  const entryFor = (entity: ODataEntity): IndexedEntity => {
    let entry = cache.get(entity);
    if (!entry) {
      entry = indexEntity(entity, metadata.entities);
      cache.set(entity, entry);
    }
    return entry;
  };

  return function search(query: string, options: SearchOptions = {}): EntityMatch[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return metadata.entities
        .filter((entity) =>
          options.includeComplexTypes === false ? entity.kind !== 'complex' : true,
        )
        .map((entity) => ({ entity, score: 0, reasons: [] as string[] }));
    }

    const matches: EntityMatch[] = [];
    for (const entity of metadata.entities) {
      if (options.includeComplexTypes === false && entity.kind === 'complex') continue;
      const match = scoreEntity(entryFor(entity), tokens);
      if (match) matches.push(match);
    }

    matches.sort((a, b) => a.score - b.score || a.entity.name.localeCompare(b.entity.name));

    return options.limit !== undefined ? matches.slice(0, options.limit) : matches;
  };
}

export interface RelationshipMatch {
  relationship: import('@odata-visualizer/shared').ODataRelationship;
  score: number;
}

/** Rank relationships against the same query terms. */
export function searchRelationships(
  relationships: import('@odata-visualizer/shared').ODataRelationship[],
  query: string,
  limit?: number,
): RelationshipMatch[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    const all = relationships.map((relationship) => ({ relationship, score: 0 }));
    return limit !== undefined ? all.slice(0, limit) : all;
  }

  const scored = relationships
    .map((relationship) => {
      const text = [
        relationship.name,
        relationship.from.entity,
        relationship.to.entity,
        relationship.namespace ?? '',
      ]
        .join(' ')
        .toLowerCase();

      let score = 0;
      for (const token of tokens) {
        if (!text.includes(token)) return null;
        score += relationship.name.toLowerCase().includes(token) ? 0 : 1;
      }
      return { relationship, score };
    })
    .filter((entry): entry is RelationshipMatch => entry !== null);

  scored.sort(
    (a, b) => a.score - b.score || a.relationship.name.localeCompare(b.relationship.name),
  );
  return limit !== undefined ? scored.slice(0, limit) : scored;
}
