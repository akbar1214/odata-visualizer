import { useState, useMemo } from 'react';
import type { ODataMetadata, ODataEntity, ODataProperty } from '@odata-visualizer/shared';

interface MetadataExplorerProps {
  metadata: ODataMetadata;
  selectedEntity?: string | null;
  onEntitySelect?: (entityName: string) => void;
}

type TabId = 'entities' | 'relationships' | 'stats';

export function MetadataExplorer({
  metadata,
  selectedEntity,
  onEntitySelect,
}: MetadataExplorerProps) {
  const [activeTab, setActiveTab] = useState<TabId>('entities');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedEntity, setExpandedEntity] = useState<string | null>(selectedEntity || null);

  const filteredEntities = useMemo(() => {
    if (!searchTerm) return metadata.entities;
    const lower = searchTerm.toLowerCase();
    return metadata.entities.filter(
      (e) =>
        e.name.toLowerCase().includes(lower) ||
        e.label?.toLowerCase().includes(lower) ||
        e.namespace?.toLowerCase().includes(lower)
    );
  }, [metadata.entities, searchTerm]);

  const stats = useMemo(() => {
    const totalProperties = metadata.entities.reduce((acc, e) => acc + e.properties.length, 0);
    const totalNavProps = metadata.entities.reduce(
      (acc, e) => acc + e.navigationProperties.length,
      0
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

  return (
    <div className="card h-full flex flex-col">
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
            onClick={() => setActiveTab(tab.id)}
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
            <div className="mb-4">
              <input
                type="text"
                placeholder="Search entities..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input"
              />
            </div>

            <div className="space-y-2">
              {filteredEntities.map((entity) => (
                <EntityCard
                  key={entity.name}
                  entity={entity}
                  isExpanded={expandedEntity === entity.name}
                  isSelected={selectedEntity === entity.name}
                  onToggle={() => {
                    setExpandedEntity(expandedEntity === entity.name ? null : entity.name);
                    onEntitySelect?.(entity.name);
                  }}
                />
              ))}
              {filteredEntities.length === 0 && (
                <div className="text-center py-8 text-engineering-500">No entities found</div>
              )}
            </div>
          </div>
        )}

        {/* Relationships Tab */}
        {activeTab === 'relationships' && (
          <div className="p-4">
            <div className="space-y-2">
              {metadata.relationships.map((rel) => (
                <div
                  key={rel.name}
                  className="p-3 bg-engineering-100 rounded hover:bg-engineering-200 cursor-pointer"
                  onClick={() => {
                    onEntitySelect?.(rel.from.entity);
                  }}
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
              {metadata.relationships.length === 0 && (
                <div className="text-center py-8 text-engineering-500">No relationships found</div>
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
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void;
}

function EntityCard({ entity, isExpanded, isSelected, onToggle }: EntityCardProps) {
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
          <div className="font-medium text-sm truncate text-black">{entity.label || entity.name}</div>
          {entity.namespace && (
            <div className="text-xs text-engineering-500 truncate">{entity.namespace}</div>
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
                    <th className="py-1">Nullable</th>
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
                      <td className="py-1 text-engineering-400">{prop.nullable ? '✓' : '✗'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Navigation Properties */}
          {entity.navigationProperties.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-engineering-500 mb-1">Navigation Properties</div>
              <div className="space-y-1">
                {entity.navigationProperties.map((nav) => (
                  <div key={nav.name} className="text-xs text-primary-500">
                    {nav.name} → {nav.relationship}
                  </div>
                ))}
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
