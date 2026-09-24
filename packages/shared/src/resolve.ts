import type {
  ODataEntity,
  ODataEntitySet,
  ODataMetadata,
  ODataNavigationProperty,
  ODataProperty,
} from './types.js';

/**
 * Find entity/complex types whose qualified or short name matches `name`
 * (case-insensitive). Returns every match so callers can disambiguate
 * namespace collisions.
 */
export function findEntitiesByName(entities: ODataEntity[], name: string): ODataEntity[] {
  const needle = name.toLowerCase();
  return entities.filter(
    (e) => e.name.toLowerCase() === needle || (e.qualifiedName?.toLowerCase() ?? '') === needle,
  );
}

/** Find a single entity by qualified or short name (case-insensitive). */
export function findEntityByName(entities: ODataEntity[], name: string): ODataEntity | undefined {
  const matches = findEntitiesByName(entities, name);
  if (matches.length === 0) return undefined;
  const exact = matches.find((e) => e.qualifiedName?.toLowerCase() === name.toLowerCase());
  return exact ?? matches[0];
}

/**
 * Resolve a type reference, preferring an exact qualified-name match and then
 * a match in the same namespace before falling back to any short-name match.
 * Short names are unique per namespace in CSDL but not across a model, so the
 * namespace hint prevents resolving `BaseType="Part"` to the wrong `Part`.
 */
function findTypeInScope(
  entities: ODataEntity[],
  name: string,
  preferredNamespace?: string,
): ODataEntity | undefined {
  const needle = name.toLowerCase();
  const byQualified = entities.find((e) => (e.qualifiedName ?? '').toLowerCase() === needle);
  if (byQualified) return byQualified;

  const sameNamespace = entities.find(
    (e) =>
      e.namespace?.toLowerCase() === preferredNamespace?.toLowerCase() &&
      e.name.toLowerCase() === needle,
  );
  if (sameNamespace) return sameNamespace;

  return entities.find((e) => e.name.toLowerCase() === needle);
}

/**
 * Resolve the inheritance chain for an entity, starting with the entity
 * itself followed by base types (base, grandbase, ...). Guards against
 * cycles.
 */
export function resolveInheritanceChain(
  entity: ODataEntity,
  entities: ODataEntity[],
): ODataEntity[] {
  const chain: ODataEntity[] = [entity];
  const seen = new Set<string>([entity.qualifiedName ?? entity.name]);
  let current = entity;

  while (current.baseType) {
    const base = findTypeInScope(entities, current.baseType, current.namespace);
    if (!base) break;
    const baseId = base.qualifiedName ?? base.name;
    if (seen.has(baseId)) break;
    seen.add(baseId);
    chain.push(base);
    current = base;
  }

  return chain;
}

/** Key property names, including keys inherited from base types. */
export function getEffectiveKeys(entity: ODataEntity, entities: ODataEntity[]): string[] {
  if (entity.keys.length > 0) return entity.keys;
  const chain = resolveInheritanceChain(entity, entities);
  for (const e of chain.slice(1)) {
    if (e.keys.length > 0) return e.keys;
  }
  return [];
}

/** Effective structural properties including inherited ones (base first). */
export function getEffectiveProperties(
  entity: ODataEntity,
  entities: ODataEntity[],
): Array<ODataProperty & { sourceType?: string }> {
  const chain = resolveInheritanceChain(entity, entities);
  const seen = new Set<string>();
  const props: Array<ODataProperty & { sourceType?: string }> = [];

  for (const e of [...chain].reverse()) {
    for (const prop of e.properties) {
      if (!seen.has(prop.name)) {
        seen.add(prop.name);
        props.push({ ...prop, sourceType: e.name });
      }
    }
  }

  return props;
}

/** Effective navigation properties including inherited ones (base first). */
export function getEffectiveNavigationProperties(
  entity: ODataEntity,
  entities: ODataEntity[],
): Array<ODataNavigationProperty & { sourceType?: string }> {
  const chain = resolveInheritanceChain(entity, entities);
  const seen = new Set<string>();
  const navs: Array<ODataNavigationProperty & { sourceType?: string }> = [];

  for (const e of [...chain].reverse()) {
    for (const nav of e.navigationProperties) {
      if (!seen.has(nav.name)) {
        seen.add(nav.name);
        navs.push({ ...nav, sourceType: e.name });
      }
    }
  }

  return navs;
}

/** Find an entity set by name (case-insensitive). */
export function findEntitySet(metadata: ODataMetadata, name: string): ODataEntitySet | undefined {
  const needle = name.toLowerCase();
  for (const container of metadata.entityContainers) {
    const set = container.entitySets.find((s) => s.name.toLowerCase() === needle);
    if (set) return set;
  }
  return undefined;
}

/** All entity sets across containers. */
export function getAllEntitySets(metadata: ODataMetadata): ODataEntitySet[] {
  return metadata.entityContainers.flatMap((c) => c.entitySets);
}

/**
 * Suggest names close to `target` using substring matching
 * (case-insensitive), closest-first.
 */
export function suggestNames(target: string, names: string[], limit = 5): string[] {
  const needle = target.toLowerCase();
  if (!needle) return [];
  const scored = names
    .map((name) => {
      const hay = name.toLowerCase();
      let score = -1;
      if (hay === needle) score = 0;
      else if (hay.includes(needle)) score = 1;
      else if (needle.includes(hay)) score = 2;
      else if (sharedPrefixLength(hay, needle) >= 3) score = 3;
      return { name, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  return scored.slice(0, limit).map((s) => s.name);
}

function sharedPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}
