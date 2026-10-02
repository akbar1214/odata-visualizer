import { useState, useMemo, useCallback } from 'react';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { EntitySelector } from './query/EntitySelector';
import { PathFinder } from './query/PathFinder';
import { FunctionImportSelector } from './query/FunctionImportSelector';
import { QueryPreview } from './query/QueryPreview';
import { QueryCanvas } from './query/QueryCanvas';
import {
  buildODataQuery,
  getEntitySelectionValue,
  getQueryableEntities,
  resolveResourcePath,
  type QueryState,
} from '../utils/queryResolver';
import {
  createRootNode,
  expandPath,
  functionStepWarnings,
  layoutGraph,
  graphToQueryState,
  type GraphNodeState,
  type GraphEdge,
  type TraversalPath,
} from '../utils/graphState';

interface QueryBuilderProps {
  metadata: ODataMetadata;
}

export function QueryBuilder({ metadata }: QueryBuilderProps) {
  const queryableEntities = useMemo(
    () => getQueryableEntities(metadata.entities),
    [metadata.entities],
  );

  const [selectedEntity, setSelectedEntity] = useState<string>(() =>
    queryableEntities.length > 0
      ? getEntitySelectionValue(queryableEntities[0], metadata.entities)
      : '',
  );

  const [graphNodes, setGraphNodes] = useState<GraphNodeState[]>(() =>
    selectedEntity ? [createRootNode(selectedEntity)] : [],
  );
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [functionQuery, setFunctionQuery] = useState<string | null>(null);

  const handleEntitySelect = useCallback((name: string) => {
    setSelectedEntity(name);
    setGraphNodes([createRootNode(name)]);
    setGraphEdges([]);
    setFunctionQuery(null);
  }, []);

  const handleGraphChange = useCallback((nodes: GraphNodeState[], edges: GraphEdge[]) => {
    setGraphNodes(nodes);
    setGraphEdges(edges);
  }, []);

  const handleSelectPath = useCallback(async (sourceEntity: string, path: TraversalPath) => {
    const state = expandPath(sourceEntity, path);
    const laid = await layoutGraph(state);
    setSelectedEntity(sourceEntity);
    setGraphNodes(laid.nodes);
    setGraphEdges(laid.edges);
    setFunctionQuery(null);
  }, []);

  const handleFunctionSelect = useCallback((query: string) => {
    setFunctionQuery(query);
  }, []);

  const query: QueryState = useMemo(
    () => graphToQueryState({ nodes: graphNodes, edges: graphEdges }, selectedEntity),
    [graphNodes, graphEdges, selectedEntity],
  );

  // One pass: the warnings describe *this* query, so they are collected while
  // it is built rather than recomputed separately (which could show reasons
  // for a different query than the one on screen). `omittedFilterCount` counts
  // only the rows missing from the query — the shared builder's advisory
  // messages are not omissions.
  const { queryString, warnings, omittedFilterCount } = useMemo(() => {
    if (functionQuery) {
      return { queryString: functionQuery, warnings: [] as string[], omittedFilterCount: 0 };
    }
    // Shapes the projection cannot carry — a function that is not the first
    // hop, root options before a function segment — are reported here, next to
    // the query that omits them.
    const warnings = functionStepWarnings({ nodes: graphNodes, edges: graphEdges });
    let omittedFilterCount = 0;
    const queryString = buildODataQuery(query, metadata, (message, omittedFilter) => {
      warnings.push(message);
      if (omittedFilter) omittedFilterCount += 1;
    });
    return { queryString, warnings, omittedFilterCount };
  }, [functionQuery, query, graphNodes, graphEdges, metadata]);

  // An entity type with no entity set anywhere in its inheritance chain has no
  // resource path, so `buildODataQuery` returns ''. Saying "select an entity"
  // when one is already selected reads as a bug. The message claims the set is
  // missing, so only show it when that is true: an exposed set whose name the
  // encoder refuses (a lone surrogate reaches `parseCSDL` through a crafted
  // upload) also returns '' but reports the encoding failure as its own warning,
  // and "not exposed as an entity set" would flatly contradict it.
  const emptyMessage = useMemo(() => {
    if (functionQuery || queryString) return undefined;
    if (!selectedEntity || resolveResourcePath(selectedEntity, metadata) !== undefined) {
      return undefined;
    }
    return `"${selectedEntity}" is not exposed as an entity set, so it has no resource path.`;
  }, [functionQuery, queryString, selectedEntity, metadata]);

  return (
    <div className="flex h-[calc(100vh-64px)]">
      {/* Left: Panel */}
      <div className="w-72 flex-shrink-0 border-r border-engineering-200 bg-white overflow-y-auto flex flex-col">
        <div className="p-4 space-y-4 flex-1">
          <EntitySelector
            entities={queryableEntities}
            identityEntities={metadata.entities}
            selected={selectedEntity}
            onSelect={handleEntitySelect}
          />

          {queryableEntities.length === 0 && (
            <p className="text-xs text-engineering-400 text-center mt-4">
              No queryable entities found. Upload metadata with entity types.
            </p>
          )}

          {selectedEntity && (
            <>
              <div className="border-t border-engineering-200 pt-4">
                <PathFinder
                  metadata={metadata}
                  currentEntity={selectedEntity}
                  onSelectPath={handleSelectPath}
                />
              </div>

              <div className="border-t border-engineering-200 pt-4">
                <FunctionImportSelector metadata={metadata} onSelect={handleFunctionSelect} />
              </div>

              <div className="border-t border-engineering-200 pt-4 text-xs text-engineering-400 space-y-1">
                <div className="font-medium text-engineering-500">Quick Guide</div>
                <div>
                  <b>Path Finder</b> - find routes between two entities
                </div>
                <div>
                  <b>Function Imports</b> - call OData functions
                </div>
                <div>
                  Click <b>$select</b> properties on any node to choose fields
                </div>
                <div>
                  Click <b>$expand</b> nav properties to add related entities
                </div>
                <div>
                  Click <b>$filter</b> to add filter conditions
                </div>
                <div>
                  Click <b>$orderby</b> to set sorting
                </div>
                <div>
                  Use <b>$top</b>/<b>$skip</b> for pagination
                </div>
                <div>
                  Click <b>✕</b> on a node to remove it
                </div>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-engineering-200 bg-engineering-100 p-3">
          <QueryPreview
            query={queryString}
            emptyMessage={emptyMessage}
            warnings={warnings}
            omittedFilterCount={omittedFilterCount}
          />
        </div>
      </div>

      {/* Right: Full canvas */}
      <div className="flex-1 bg-engineering-100">
        <QueryCanvas
          graphNodes={graphNodes}
          graphEdges={graphEdges}
          metadata={metadata}
          onGraphChange={handleGraphChange}
        />
      </div>
    </div>
  );
}
