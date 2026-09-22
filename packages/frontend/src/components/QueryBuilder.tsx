import { useState, useMemo, useCallback } from 'react';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { EntitySelector } from './query/EntitySelector';
import { PathFinder } from './query/PathFinder';
import { FunctionImportSelector } from './query/FunctionImportSelector';
import { QueryPreview } from './query/QueryPreview';
import { QueryCanvas } from './query/QueryCanvas';
import { buildODataQuery, getQueryableEntities, type QueryState } from '../utils/queryResolver';
import {
  createRootNode,
  expandPath,
  layoutGraph,
  graphToExpandItems,
  type GraphNodeState,
  type GraphEdge,
  type EntityPath,
} from '../utils/graphState';

interface QueryBuilderProps {
  metadata: ODataMetadata;
}

export function QueryBuilder({ metadata }: QueryBuilderProps) {
  const queryableEntities = useMemo(
    () => getQueryableEntities(metadata.entities),
    [metadata.entities],
  );

  const [selectedEntity, setSelectedEntity] = useState<string>(
    queryableEntities.length > 0 ? queryableEntities[0].name : '',
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

  const handleSelectPath = useCallback(async (sourceEntity: string, path: EntityPath) => {
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

  const query: QueryState = useMemo(() => {
    const rootNode = graphNodes.find((n) => n.id === 'root');
    if (!rootNode) {
      return {
        entityName: selectedEntity,
        filters: [],
        filterLogic: 'and',
        select: [],
        expand: [],
        sort: '',
        sortDirection: 'asc',
        top: 25,
        skip: 0,
      };
    }

    return {
      entityName: rootNode.entityName,
      filters: rootNode.filters,
      filterLogic: rootNode.filterLogic,
      select: rootNode.select,
      expand: graphToExpandItems({ nodes: graphNodes, edges: graphEdges }, 'root'),
      sort: rootNode.sort,
      sortDirection: rootNode.sortDirection,
      top: rootNode.top,
      skip: rootNode.skip,
    };
  }, [graphNodes, graphEdges, selectedEntity]);

  const queryString = useMemo(() => {
    if (functionQuery) {
      return functionQuery;
    }
    return buildODataQuery(query, metadata);
  }, [functionQuery, query, metadata]);

  return (
    <div className="flex h-[calc(100vh-64px)]">
      {/* Left: Panel */}
      <div className="w-72 flex-shrink-0 border-r border-engineering-200 bg-white overflow-y-auto flex flex-col">
        <div className="p-4 space-y-4 flex-1">
          <EntitySelector
            entities={metadata.entities}
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
          <QueryPreview query={queryString} />
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
