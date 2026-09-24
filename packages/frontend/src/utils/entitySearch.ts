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
  /** Restrict to a kind. Applied before any caller-side limit. */
  kind?: 'all' | 'entity' | 'complex';
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
  /** Property / navigation / annotation values, matched individually so a
   *  token can never span the boundary between two entries. */
  propertyNames: string[];
  navigationNames: string[];
  annotationValues: string[];
}

function toList(values: string[]): string[] {
  return values.map((value) => value.toLowerCase());
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
    propertyNames: toList(properties.map((p) => p.name)),
    navigationNames: toList(navigations.map((n) => n.name)),
    annotationValues: toList([
      entity.label ?? '',
      ...Object.entries(entity.annotations ?? {}).flatMap(([term, value]) => [term, value]),
    ]),
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

  // Match each name individually: joining them would let a token span two
  // property names (e.g. "bercu" across "number" + "currency").
  const propertyHit = entry.propertyNames.find((name) => name.includes(token));
  if (propertyHit) return { score: SCORE.propertyContains, reason: `property: ${propertyHit}` };

  const navigationHit = entry.navigationNames.find((name) => name.includes(token));
  if (navigationHit) {
    return { score: SCORE.navigationContains, reason: `navigation: ${navigationHit}` };
  }

  const annotationHit = entry.annotationValues.find((value) => value.includes(token));
  if (annotationHit) {
    return { score: SCORE.annotationContains, reason: `description: ${truncate(annotationHit)}` };
  }
  return { score: Number.POSITIVE_INFINITY };
}

function truncate(value: string, max = 40): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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
    const includeComplex = (options.includeComplexTypes ?? true) && options.kind !== 'entity';

    const allowed = metadata.entities.filter((entity) => {
      if (!includeComplex && entity.kind === 'complex') return false;
      if (options.kind === 'complex') return entity.kind === 'complex';
      if (options.kind === 'entity') return entity.kind !== 'complex';
      return true;
    });

    if (tokens.length === 0) {
      return allowed.map((entity) => ({ entity, score: 0, reasons: [] as string[] }));
    }

    const matches: EntityMatch[] = [];
    for (const entity of allowed) {
      const match = scoreEntity(entryFor(entity), tokens);
      if (match) matches.push(match);
    }

    // Ranked, best first. Callers slice, so they can report a total and apply
    // their own cap after filtering.
    matches.sort((a, b) => a.score - b.score || a.entity.name.localeCompare(b.entity.name));
    return matches;
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
