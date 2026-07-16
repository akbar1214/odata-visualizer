import { useState, useMemo } from 'react';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { findPaths, getReachableEntities, type EntityPath } from '../../utils/graphState';
import { SearchableSelect } from './SearchableSelect';

interface PathFinderProps {
  metadata: ODataMetadata;
  currentEntity: string;
  onSelectPath: (sourceEntity: string, path: EntityPath) => void;
}

export function PathFinder({ metadata, currentEntity, onSelectPath }: PathFinderProps) {
  const [sourceEntity, setSourceEntity] = useState(currentEntity);
  const [targetEntity, setTargetEntity] = useState('');
  const [foundPaths, setFoundPaths] = useState<EntityPath[]>([]);
  const [searched, setSearched] = useState(false);

  const reachableEntities = useMemo(() => {
    if (!sourceEntity) return new Set<string>();
    const reachable = getReachableEntities(sourceEntity, metadata);
    const names = new Set<string>();
    for (const targets of reachable.values()) {
      for (const t of targets) {
        names.add(t.entity.name);
      }
    }
    return names;
  }, [sourceEntity, metadata]);

  const targetEntities = useMemo(
    () => metadata.entities.filter((e) => e.name !== sourceEntity && reachableEntities.has(e.name)),
    [metadata.entities, sourceEntity, reachableEntities],
  );

  const handleFind = () => {
    if (!sourceEntity || !targetEntity) return;
    const paths = findPaths(sourceEntity, targetEntity, metadata);
    setFoundPaths(paths);
    setSearched(true);
  };

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-engineering-500">Path Finder</div>

      <div className="space-y-2">
        <div>
          <label className="text-[10px] text-engineering-400 block mb-0.5">From entity</label>
          <SearchableSelect
            entities={metadata.entities}
            value={sourceEntity}
            onChange={(name) => {
              setSourceEntity(name);
              setTargetEntity('');
              setFoundPaths([]);
              setSearched(false);
            }}
            placeholder="Search source..."
          />
        </div>

        <div>
          <label className="text-[10px] text-engineering-400 block mb-0.5">To entity</label>
          <SearchableSelect
            entities={targetEntities}
            value={targetEntity}
            onChange={setTargetEntity}
            placeholder={sourceEntity ? 'Search target...' : 'Select source first...'}
            disabled={!sourceEntity}
          />
        </div>

        <button
          onClick={handleFind}
          disabled={!sourceEntity || !targetEntity}
          className="w-full px-3 py-1.5 bg-primary-500 text-white text-xs rounded hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Find Paths
        </button>
      </div>

      {searched && (
        <div className="space-y-2">
          <div className="text-[10px] text-engineering-400">
            {foundPaths.length === 0 ? 'No paths found' : `${foundPaths.length} path(s) found`}
          </div>

          {foundPaths.map((path, index) => (
            <button
              key={path.map((s) => s.navProperty).join('-') || `path-${index}`}
              onClick={() => onSelectPath(sourceEntity, path)}
              className="w-full text-left p-2 rounded border border-engineering-200 hover:border-primary-300 hover:bg-primary-50 transition-colors"
            >
              <div className="text-[10px] font-medium text-engineering-600 mb-1">
                Path {index + 1} ({path.length} hop{path.length !== 1 ? 's' : ''})
              </div>
              <div className="space-y-0.5">
                {path.map((step) => (
                  <div key={`${step.fromEntity}-${step.navProperty}-${step.toEntity}`} className="flex items-center gap-1 text-[10px]">
                    <span className="text-engineering-500">{step.fromEntity}</span>
                    <span className="text-primary-500">→</span>
                    <span className="text-primary-500 font-medium">.{step.navProperty}</span>
                    <span className="text-primary-500">→</span>
                    <span className="text-engineering-500">{step.toEntity}</span>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
