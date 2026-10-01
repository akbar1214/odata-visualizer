import { useState, useMemo, useCallback, useEffect } from 'react';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { isComposableEdge } from '@odata-visualizer/shared';
import {
  findPaths,
  getReachableEntities,
  isComposablePath,
  type TraversalPath,
} from '../../utils/graphState';
import { getEntitySelectionValue } from '../../utils/queryResolver';
import { SearchableSelect } from './SearchableSelect';

interface PathFinderProps {
  metadata: ODataMetadata;
  currentEntity: string;
  onSelectPath: (sourceEntity: string, path: TraversalPath) => void;
}

/** The step label: `.Name` for a navigation property, `B()` for a function. */
function stepLabel(step: TraversalPath[number]): string {
  return step.edge.kind === 'nav' ? `.${step.edge.name}` : `${step.edge.functionName}()`;
}

export function PathFinder({ metadata, currentEntity, onSelectPath }: PathFinderProps) {
  const [sourceEntity, setSourceEntity] = useState(currentEntity);
  const [targetEntity, setTargetEntity] = useState('');
  const [foundPaths, setFoundPaths] = useState<TraversalPath[]>([]);
  const [searched, setSearched] = useState(false);

  // `currentEntity` was only read on mount, so changing the query root left the
  // "From entity" control pointing at the previous entity — and running a path
  // then silently reset the query root back to it.
  useEffect(() => {
    setSourceEntity(currentEntity);
    setTargetEntity('');
    setFoundPaths([]);
    setSearched(false);
  }, [currentEntity]);

  // The dropdown values are graph identities, exactly what `findPaths`
  // compares. An edge whose bound function needs parameters this builder
  // cannot supply is not offered as a target.
  const reachableEntities = useMemo(() => {
    if (!sourceEntity) return new Set<string>();
    const reachable = getReachableEntities(sourceEntity, metadata);
    const identities = new Set<string>();
    for (const steps of reachable.values()) {
      for (const step of steps) {
        if (isComposableEdge(step.edge)) identities.add(step.to);
      }
    }
    return identities;
  }, [sourceEntity, metadata]);

  const targetEntities = useMemo(
    () =>
      metadata.entities.filter((e) => {
        const identity = getEntitySelectionValue(e, metadata.entities);
        return identity !== sourceEntity && reachableEntities.has(identity);
      }),
    [metadata.entities, sourceEntity, reachableEntities],
  );

  const handleFind = () => {
    if (!sourceEntity || !targetEntity) return;
    const paths = findPaths(sourceEntity, targetEntity, metadata);
    setFoundPaths(paths);
    setSearched(true);
  };

  // A bound function with parameters cannot be composed without values the
  // builder has no input for, and a function that is not the first hop cannot
  // be a resource-path segment; those paths are hidden rather than emitted
  // with a missing parameter.
  const selectablePaths = useMemo(
    () => foundPaths.filter((path) => isComposablePath(path)),
    [foundPaths],
  );
  const hiddenPathCount = foundPaths.length - selectablePaths.length;

  const handleSourceChange = useCallback((name: string) => {
    setSourceEntity(name);
    setTargetEntity('');
    setFoundPaths([]);
    setSearched(false);
  }, []);

  const handleSelectPath = useCallback(
    (path: TraversalPath) => {
      onSelectPath(sourceEntity, path);
    },
    [onSelectPath, sourceEntity],
  );

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-engineering-500">Path Finder</div>

      <div className="space-y-2">
        <div>
          <label className="text-[10px] text-engineering-400 block mb-0.5">From entity</label>
          <SearchableSelect
            entities={metadata.entities}
            value={sourceEntity}
            onChange={handleSourceChange}
            placeholder="Search source..."
          />
        </div>

        <div>
          <label className="text-[10px] text-engineering-400 block mb-0.5">To entity</label>
          <SearchableSelect
            entities={targetEntities}
            identityEntities={metadata.entities}
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

          {hiddenPathCount > 0 && (
            <div className="text-[10px] text-engineering-400">
              {hiddenPathCount} path(s) hidden: this builder cannot compose them (a bound function
              needs parameters, or is not the first hop).
            </div>
          )}

          {selectablePaths.map((path, index) => (
            <button
              key={path.map((s) => stepLabel(s)).join('-') || `path-${index}`}
              onClick={() => handleSelectPath(path)}
              className="w-full text-left p-2 rounded border border-engineering-200 hover:border-primary-300 hover:bg-primary-50 transition-colors"
            >
              <div className="text-[10px] font-medium text-engineering-600 mb-1">
                Path {index + 1} ({path.length} hop{path.length !== 1 ? 's' : ''})
              </div>
              <div className="space-y-0.5">
                {path.map((step) => (
                  <div
                    key={`${step.from}-${stepLabel(step)}-${step.to}`}
                    className="flex items-center gap-1 text-[10px]"
                  >
                    <span className="text-engineering-500">{step.from}</span>
                    <span className="text-primary-500">→</span>
                    <span className="text-primary-500 font-medium">{stepLabel(step)}</span>
                    <span className="text-primary-500">→</span>
                    <span className="text-engineering-500">{step.to}</span>
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
