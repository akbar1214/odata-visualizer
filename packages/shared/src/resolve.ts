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

/**
 * Find a single entity by qualified or short name.
 *
 * Matching is case-insensitive — services in the wild are sloppy about case, and
 * a strict match would reject models that work against their own server — but an
 * **exact-case match wins**. Without that, a model declaring both `Shop.Order`
 * and `SHOP.Order` resolved to whichever came first in the document, so the
 * caller's spelling was ignored. Case-insensitivity is the fallback, not the
 * rule.
 */
export function findEntityByName(entities: ODataEntity[], name: string): ODataEntity | undefined {
  const matches = findEntitiesByName(entities, name);
  if (matches.length === 0) return undefined;
  const exactCase =
    matches.find((e) => e.qualifiedName === name) ?? matches.find((e) => e.name === name);
  if (exactCase) return exactCase;
  const qualified = matches.find((e) => e.qualifiedName?.toLowerCase() === name.toLowerCase());
  return qualified ?? matches[0];
}

/**
 * Resolve a type reference, preferring an exact qualified-name match and then
 * a match in the same namespace before falling back to any short-name match.
 * Short names are unique per namespace in CSDL but not across a model, so the
 * namespace hint prevents resolving `BaseType="Part"` to the wrong `Part`.
 *
 * The parser's annotation resolver uses this too: a bare `<Annotations
 * Target="Part">` block must attach to the `Part` its own schema declares, not
 * to whichever `Part` happens to come first in the document.
 */
export function findTypeInScope(
  entities: ODataEntity[],
  name: string,
  preferredNamespace?: string,
): ODataEntity | undefined {
  // Exact case first. CSDL identifiers are case-sensitive and a model may
  // declare both `Shop.Order` and `SHOP.Order`; going straight to the lowercased
  // comparison resolved `BaseType="SHOP.Order"` to whichever came first in the
  // document, silently rewriting the inheritance chain — and with it the keys,
  // properties and navigation properties every consumer sees.
  const exactQualified = entities.find((e) => e.qualifiedName === name);
  if (exactQualified) return exactQualified;

  const exactSameNamespace = entities.find(
    (e) => e.namespace === preferredNamespace && e.name === name,
  );
  if (exactSameNamespace) return exactSameNamespace;

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

/**
 * Find an entity set by name.
 *
 * Case-insensitive, with the same rule as the type lookups: an exact-case match
 * wins, so two sets differing only by case resolve to the spelling that was
 * asked for rather than to document order.
 */
export function findEntitySet(metadata: ODataMetadata, name: string): ODataEntitySet | undefined {
  const needle = name.toLowerCase();
  let fallback: ODataEntitySet | undefined;
  for (const container of metadata.entityContainers) {
    for (const set of container.entitySets) {
      if (set.name === name) return set;
      if (!fallback && set.name.toLowerCase() === needle) fallback = set;
    }
  }
  return fallback;
}

/**
 * Find an entity set by name, preferring one declared in `preferredNamespace`.
 *
 * The policy is `findEntitySet`'s — an exact-case match wins and a
 * case-insensitive match is only the fallback — with the namespace preference
 * applied at both levels. A bare annotation target must reach the set its own
 * schema declares before one in another schema.
 */
export function findEntitySetInScope(
  metadata: ODataMetadata,
  name: string,
  preferredNamespace?: string,
): ODataEntitySet | undefined {
  const needle = name.toLowerCase();
  const scoped = metadata.entityContainers
    .filter((container) => container.namespace === preferredNamespace)
    .flatMap((container) => container.entitySets);

  const exactScoped = scoped.find((set) => set.name === name);
  if (exactScoped) return exactScoped;

  const exact = getAllEntitySets(metadata).find((set) => set.name === name);
  if (exact) return exact;

  const caseInsensitiveScoped = scoped.find((set) => set.name.toLowerCase() === needle);
  if (caseInsensitiveScoped) return caseInsensitiveScoped;

  return getAllEntitySets(metadata).find((set) => set.name.toLowerCase() === needle);
}

/**
 * Every entity set, flattened in document order.
 *
 * Containers are concatenated, so a type exposed by sets in *two* containers
 * always resolves to the first one: `setForType` takes the first match and no
 * container-qualified path is emitted. That is a recorded limitation rather than
 * an accident (#18 item 3) — a service normally exposes a single default
 * container, and `assertResourceSegment` in `query.ts` already accepts a
 * `Container/Set` segment if a real model ever needs one.
 */
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
