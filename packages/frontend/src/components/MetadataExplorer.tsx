import { useState, useMemo, useCallback, useEffect } from 'react';
import type { ODataMetadata, ODataEntity, ODataProperty } from '@odata-visualizer/shared';
import { getTargetEntityName } from '../utils/queryResolver';
import { createEntitySearch, searchRelationships } from '../utils/entitySearch';

interface MetadataExplorerProps {
  metadata: ODataMetadata;
  selectedEntity?: string | null;
  onEntitySelect?: (entityName: string) => void;
}

type TabId = 'entities' | 'relationships' | 'stats';
type KindFilter = 'all' | 'entity' | 'complex';

/** Cap the rendered list so huge models stay responsive. */
const MAX_RESULTS = 200;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

const SORTABLE_TYPES = new Set([
  'Edm.String',
  'Edm.Boolean',
  'Edm.Guid',
  'Edm.Date',
  'Edm.DateTime',
  'Edm.DateTimeOffset',
  'Edm.Time',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Single',
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Byte',
  'Edm.SByte',
]);

function isSortableType(type: string): boolean {
  if (SORTABLE_TYPES.has(type)) return true;
  return type.startsWith('Edm.Int') || type.startsWith('Edm.Float') || type.startsWith('Edm.Dec');
}

export function MetadataExplorer({
  metadata,
  selectedEntity,
  onEntitySelect,
}: MetadataExplorerProps) {
  const [activeTab, setActiveTab] = useState<TabId>('entities');
  const [rawQuery, setRawQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [expandedEntity, setExpandedEntity] = useState<string | null>(selectedEntity || null);

  // Debounced so typing stays smooth on Windchill-sized models.
  const query = useDebouncedValue(rawQuery.trim(), 150);
  const search = useMemo(() => createEntitySearch(metadata), [metadata]);

  // The kind filter is applied by the search (before any cap), so filtering to
  // complex types is not starved by higher-ranked entity types.
  const allEntityMatches = useMemo(
    () => search(query, { kind: kindFilter }),
    [search, query, kindFilter],
  );
  const entityMatches = useMemo(() => allEntityMatches.slice(0, MAX_RESULTS), [allEntityMatches]);

  // Denominator: how many types the current kind filter covers, so "3 of 4"
  // means "3 matched out of 4 searchable types".
  const kindTotal = useMemo(() => search('', { kind: kindFilter }).length, [search, kindFilter]);

  const allRelationshipMatches = useMemo(
    () => searchRelationships(metadata.relationships, query),
    [metadata.relationships, query],
  );
  const relationshipMatches = useMemo(
    () => allRelationshipMatches.slice(0, MAX_RESULTS),
    [allRelationshipMatches],
  );

  const stats = useMemo(() => {
    const totalProperties = metadata.entities.reduce((acc, e) => acc + e.properties.length, 0);
    const totalNavProps = metadata.entities.reduce(
      (acc, e) => acc + e.navigationProperties.length,
      0,
    );
    const namespaces = new Set(metadata.entities.map((e) => e.namespace).filter(Boolean));

    return {
      totalEntities: metadata.entities.length,
      totalProperties,
      totalNavigationProperties: totalNavProps,
      totalRelationships: metadata.relationships.length,
      namespaces: Array.from(namespaces),
    };
  }, [metadata]);

  const handleTabClick = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
  }, []);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRawQuery(e.target.value);
  }, []);

  const clearSearch = useCallback(() => setRawQuery(''), []);

  // Track the diagram selection. The explorer keys cards by qualified name
  // while the diagram identifies nodes by short name, so resolve the match.
  useEffect(() => {
    if (!selectedEntity) return;
    const match = metadata.entities.find(
      (entity) => entity.name === selectedEntity || entity.qualifiedName === selectedEntity,
    );
    setExpandedEntity(match ? (match.qualifiedName ?? match.name) : selectedEntity);
  }, [selectedEntity, metadata.entities]);

  const handleEntityToggle = useCallback(
    (entityKey: string, entityName: string) => {
      setExpandedEntity((current) => (current === entityKey ? null : entityKey));
      onEntitySelect?.(entityName);
    },
    [onEntitySelect],
  );

  const handleRelationshipClick = useCallback(
    (entityName: string) => {
      onEntitySelect?.(entityName);
    },
    [onEntitySelect],
  );

  return (
    <div className="card h-full flex flex-col">
      {/* Search — shared by the Entities and Relationships tabs */}
      <div className="p-4 border-b border-engineering-200">
        <div className="relative">
          <input
            type="text"
            placeholder="Search types, properties, descriptions..."
            value={rawQuery}
            onChange={handleSearchChange}
            className="input pr-8"
            aria-label="Search metadata"
          />
          {rawQuery && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-engineering-400 hover:text-engineering-600"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        {activeTab !== 'stats' && (
          <div className="mt-2 flex items-center justify-between text-xs text-engineering-500">
            <span>
              {query || kindFilter !== 'all' || allEntityMatches.length > MAX_RESULTS
                ? activeTab === 'relationships'
                  ? `${relationshipMatches.length} of ${allRelationshipMatches.length} ${plural(
                      allRelationshipMatches.length,
                      'relationship',
                      'relationships',
                    )}`
                  : `${entityMatches.length} of ${kindTotal} ${plural(kindTotal, 'type')}`
                : ''}
            </span>
            {activeTab !== 'relationships' && (
              <div className="flex gap-1">
                {[
                  { id: 'all' as const, label: 'All' },
                  { id: 'entity' as const, label: 'Entities' },
                  { id: 'complex' as const, label: 'Complex' },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setKindFilter(option.id)}
                    aria-pressed={kindFilter === option.id}
                    className={`px-2 py-0.5 rounded ${
                      kindFilter === option.id
                        ? 'bg-primary-500 text-white'
                        : 'bg-engineering-100 hover:bg-engineering-200'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {activeTab === 'relationships'
          ? allRelationshipMatches.length > MAX_RESULTS && (
              <div className="mt-1 text-xs text-engineering-400">
                {`Showing the first ${MAX_RESULTS} of ${allRelationshipMatches.length} relationships — refine your search.`}
              </div>
            )
          : allEntityMatches.length > MAX_RESULTS && (
              <div className="mt-1 text-xs text-engineering-400">
                {`Showing the first ${MAX_RESULTS} of ${allEntityMatches.length} ${plural(
                  allEntityMatches.length,
                  'type',
                )} — refine your search.`}
              </div>
            )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-engineering-200">
        {[
          { id: 'entities' as const, label: 'Entities', count: metadata.entities.length },
          {
            id: 'relationships' as const,
            label: 'Relationships',
            count: metadata.relationships.length,
          },
          { id: 'stats' as const, label: 'Stats', count: null },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabClick(tab.id)}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-primary-500 border-b-2 border-primary-500'
                : 'text-engineering-500 hover:text-engineering-600'
            }`}
          >
            {tab.label}
            {tab.count !== null && (
              <span className="ml-1.5 text-xs bg-engineering-100 px-1.5 py-0.5 rounded">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {/* Entities Tab */}
        {activeTab === 'entities' && (
          <div className="p-4">
            <div className="space-y-2">
              {entityMatches.map((match) => {
                const entity = match.entity;
                const entityKey = entity.qualifiedName ?? entity.name;
                return (
                  <EntityCard
                    key={entityKey}
                    entity={entity}
                    matchReason={match.reasons.join(', ')}
                    isExpanded={expandedEntity === entityKey}
                    isSelected={selectedEntity === entity.name}
                    metadata={metadata}
                    onToggle={() => handleEntityToggle(entityKey, entity.name)}
                    onNavigate={onEntitySelect}
                  />
                );
              })}
              {entityMatches.length === 0 && (
                <div className="text-center py-8 text-engineering-500">
                  {query ? `No types match "${query}"` : 'No entities found'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Relationships Tab */}
        {activeTab === 'relationships' && (
          <div className="p-4">
            <div className="space-y-2">
              {relationshipMatches.map(({ relationship: rel }) => (
                <div
                  key={`${rel.name}-${rel.from.entity}-${rel.to.entity}`}
                  className="p-3 bg-engineering-100 rounded hover:bg-engineering-200 cursor-pointer"
                  onClick={() => handleRelationshipClick(rel.from.entity)}
                >
                  <div className="font-mono text-sm font-medium text-black">{rel.name}</div>
                  <div className="text-xs text-engineering-500 mt-1 flex items-center gap-2">
                    <span className="text-primary-500">{rel.from.entity}</span>
                    <span>({rel.from.multiplicity})</span>
                    <span>→</span>
                    <span className="text-primary-500">{rel.to.entity}</span>
                    <span>({rel.to.multiplicity})</span>
                  </div>
                </div>
              ))}
              {relationshipMatches.length === 0 && (
                <div className="text-center py-8 text-engineering-500">
                  {query ? `No relationships match "${query}"` : 'No relationships found'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Stats Tab */}
        {activeTab === 'stats' && (
          <div className="p-4">
            <div className="grid grid-cols-2 gap-4">
              <StatCard label="Entities" value={stats.totalEntities} />
              <StatCard label="Properties" value={stats.totalProperties} />
              <StatCard label="Relationships" value={stats.totalRelationships} />
              <StatCard label="Navigation Props" value={stats.totalNavigationProperties} />
            </div>

            {stats.namespaces.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium text-engineering-600 mb-2">Namespaces</h3>
                <div className="space-y-1">
                  {stats.namespaces.map((ns) => (
                    <div
                      key={ns}
                      className="text-xs font-mono text-engineering-600 bg-engineering-100 px-2 py-1 rounded"
                    >
                      {ns}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface EntityCardProps {
  entity: ODataEntity;
  matchReason?: string;
  isExpanded: boolean;
  isSelected: boolean;
  metadata: ODataMetadata;
  onToggle: () => void;
  onNavigate?: (entityName: string) => void;
}

function EntityCard({
  entity,
  matchReason,
  isExpanded,
  isSelected,
  metadata,
  onToggle,
  onNavigate,
}: EntityCardProps) {
  return (
    <div
      className={`border rounded overflow-hidden transition-all ${
        isSelected ? 'border-primary-500 ring-1 ring-primary-500' : 'border-engineering-200'
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 text-left hover:bg-engineering-100 flex items-center justify-between"
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate text-black">
            {entity.label || entity.name}
            {entity.kind === 'complex' && (
              <span className="ml-2 text-xs bg-engineering-100 text-engineering-600 px-1.5 py-0.5 rounded">
                complex
              </span>
            )}
          </div>
          <div className="text-xs text-engineering-500 truncate">
            {entity.qualifiedName ?? entity.name}
          </div>
          {matchReason && (
            <div className="text-xs text-primary-600 truncate">matches {matchReason}</div>
          )}
        </div>
        <div className="flex items-center gap-2 ml-2">
          <span className="text-xs text-engineering-400">{entity.properties.length} props</span>
          <svg
            className={`w-4 h-4 text-engineering-400 transition-transform ${
              isExpanded ? 'rotate-180' : ''
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 border-t border-engineering-200 bg-engineering-100">
          {/* Keys */}
          {entity.keys.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-engineering-500 mb-1">Primary Keys</div>
              <div className="flex flex-wrap gap-1">
                {entity.keys.map((key) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 text-xs bg-infineon-sand/20 text-engineering-600 px-2 py-0.5 rounded"
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {key}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Properties Table */}
          <div className="mt-3">
            <div className="text-xs font-medium text-engineering-500 mb-1">Properties</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-engineering-500 border-b border-engineering-200">
                    <th className="py-1 pr-2">Name</th>
                    <th className="py-1 pr-2">Type</th>
                    <th className="py-1 pr-2">Nullable</th>
                    <th className="py-1 pr-2" title="Can use in $select">
                      $select
                    </th>
                    <th className="py-1" title="Can use in $orderby">
                      $orderby
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entity.properties.map((prop: ODataProperty) => (
                    <tr key={prop.name} className="border-b border-engineering-100">
                      <td className="py-1 pr-2 font-mono">
                        {prop.isKey && (
                          <span className="text-infineon-sand mr-1" title="Primary Key">
                            🔑
                          </span>
                        )}
                        {prop.name}
                      </td>
                      <td className="py-1 pr-2 text-engineering-500">
                        {prop.type.replace('Edm.', '')}
                      </td>
                      <td className="py-1 pr-2 text-engineering-400">
                        {prop.nullable ? '✓' : '✗'}
                      </td>
                      <td className="py-1 pr-2 text-infineon-green" title="Selectable">
                        ✓
                      </td>
                      <td
                        className="py-1 text-primary-500"
                        title={isSortableType(prop.type) ? 'Sortable' : 'Not sortable'}
                      >
                        {isSortableType(prop.type) ? '✓' : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Navigation Properties */}
          {entity.navigationProperties.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-engineering-500 mb-1">
                Navigation Properties
              </div>
              <div className="space-y-1">
                {entity.navigationProperties.map((nav) => {
                  const targetName = getTargetEntityName(nav.name, entity, metadata);
                  return (
                    <div key={nav.name} className="text-xs flex items-center gap-1">
                      <span className="text-engineering-600 font-mono">{nav.name}</span>
                      <span className="text-engineering-400">→</span>
                      {targetName ? (
                        <button
                          type="button"
                          onClick={() => onNavigate?.(targetName)}
                          className="text-primary-500 hover:text-primary-600 hover:underline font-medium"
                        >
                          {targetName}
                        </button>
                      ) : (
                        <span className="text-engineering-400">
                          {nav.relationship || 'unknown'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-engineering-100 rounded p-4">
      <div className="text-2xl font-bold text-primary-500">{value.toLocaleString()}</div>
      <div className="text-sm text-engineering-500 mt-1">{label}</div>
    </div>
  );
}
