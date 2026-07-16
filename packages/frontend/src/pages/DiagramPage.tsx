import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { ERDiagram } from '../components/ERDiagram';
import { MetadataExplorer } from '../components/MetadataExplorer';
import type { ODataMetadata } from '@odata-visualizer/shared';

interface DiagramPageProps {
  metadata: ODataMetadata;
  parseTimeMs: number | null;
  fileSizeBytes: number | null;
  onClear: () => void;
}

export function DiagramPage({ metadata, parseTimeMs, fileSizeBytes, onClear }: DiagramPageProps) {
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  const formatFileSize = (bytes: number | null): string => {
    if (bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <ReactFlowProvider>
      <div className="min-h-screen bg-gray-100 flex flex-col">
        {/* Header */}
        <header className="bg-white border-b shadow-sm flex-shrink-0">
          <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">OD</span>
              </div>
              <h1 className="text-xl font-semibold text-gray-900">OData Visualizer</h1>
            </div>

            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span>{metadata.entities.length} entities</span>
              <span>{metadata.relationships.length} relationships</span>
              {parseTimeMs && <span>Parsed in {parseTimeMs}ms</span>}
              {fileSizeBytes && <span>{formatFileSize(fileSizeBytes)}</span>}
              <Link
                to="/query"
                className="btn btn-primary text-sm"
              >
                Query Builder
              </Link>
              <button
                onClick={() => {
                  onClear();
                  setSelectedEntity(null);
                }}
                className="btn btn-secondary text-sm"
              >
                New File
              </button>
            </div>
          </div>
        </header>

        {/* Diagram View */}
        <main className="flex-1 flex gap-4 p-4 overflow-hidden">
          <div className="flex-1">
            <ERDiagram
              metadata={metadata}
              selectedEntity={selectedEntity}
              onEntitySelect={setSelectedEntity}
            />
          </div>

          <div className="w-80 flex-shrink-0">
            <MetadataExplorer
              metadata={metadata}
              selectedEntity={selectedEntity}
              onEntitySelect={setSelectedEntity}
            />
          </div>
        </main>
      </div>
    </ReactFlowProvider>
  );
}
