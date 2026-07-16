import { useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { MetadataInput } from './components/MetadataInput';
import { ERDiagram } from './components/ERDiagram';
import { MetadataExplorer } from './components/MetadataExplorer';
import { ChatPanel } from './components/ChatPanel';
import { useMetadata } from './hooks/useMetadata';

function App() {
  const {
    metadata,
    loading,
    error,
    parseTimeMs,
    fileSizeBytes,
    sessionId,
    loadFile,
    loadUrl,
    clear,
  } = useMetadata();

  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  const formatFileSize = (bytes: number | null): string => {
    if (bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <ReactFlowProvider>
      <div className="min-h-screen bg-gray-100">
        {/* Header */}
        <header className="bg-white border-b shadow-sm">
          <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">OD</span>
              </div>
              <h1 className="text-xl font-semibold text-gray-900">OData Visualizer</h1>
            </div>

            {metadata && (
              <div className="flex items-center gap-4 text-sm text-gray-500">
                <span>{metadata.entities.length} entities</span>
                <span>{metadata.relationships.length} relationships</span>
                {parseTimeMs && <span>Parsed in {parseTimeMs}ms</span>}
                {fileSizeBytes && <span>{formatFileSize(fileSizeBytes)}</span>}
                <button
                  onClick={() => setChatOpen(!chatOpen)}
                  className={`btn text-sm ${chatOpen ? 'btn-primary' : 'btn-secondary'}`}
                >
                  {chatOpen ? 'Hide Chat' : 'AI Chat'}
                </button>
                <button
                  onClick={() => {
                    clear();
                    setSelectedEntity(null);
                    setChatOpen(false);
                  }}
                  className="btn btn-secondary text-sm"
                >
                  New File
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-full mx-auto p-4">
          {!metadata ? (
            /* Input View */
            <div className="max-w-xl mx-auto mt-12">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  Visualize OData Metadata
                </h2>
                <p className="text-gray-600">
                  Upload an OData metadata file or provide a URL to generate an interactive
                  entity-relationship diagram.
                </p>
              </div>

              <MetadataInput
                onFileSelect={loadFile}
                onUrlSubmit={loadUrl}
                loading={loading}
              />

              {error && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-start gap-3">
                    <svg
                      className="w-5 h-5 text-red-500 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <div>
                      <h3 className="text-sm font-medium text-red-800">Error</h3>
                      <p className="text-sm text-red-700 mt-1">{error}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Features */}
              <div className="mt-12 grid grid-cols-3 gap-6">
                <FeatureCard
                  title="Interactive Diagram"
                  description="Zoom, pan, and explore entity relationships visually"
                  icon={
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
                      />
                    </svg>
                  }
                />
                <FeatureCard
                  title="Large File Support"
                  description="Handles OData metadata files up to 100MB with streaming parsing"
                  icon={
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                      />
                    </svg>
                  }
                />
                <FeatureCard
                  title="AI Query Assistant"
                  description="Ask questions in natural language and get OData queries"
                  icon={
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                      />
                    </svg>
                  }
                />
              </div>
            </div>
          ) : (
            /* Diagram View */
            <div className="flex gap-4 h-[calc(100vh-80px)]">
              {/* Diagram */}
              <div className="flex-1">
                <ERDiagram
                  metadata={metadata}
                  selectedEntity={selectedEntity}
                  onEntitySelect={setSelectedEntity}
                />
              </div>

              {/* Explorer Sidebar */}
              <div className="w-80 flex-shrink-0">
                <MetadataExplorer
                  metadata={metadata}
                  selectedEntity={selectedEntity}
                  onEntitySelect={setSelectedEntity}
                />
              </div>

              {/* Chat Panel */}
              {chatOpen && sessionId && (
                <div className="w-80 flex-shrink-0 card overflow-hidden">
                  <ChatPanel sessionId={sessionId} />
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </ReactFlowProvider>
  );
}

function FeatureCard({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <div className="w-12 h-12 bg-primary-100 text-primary-600 rounded-lg flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="font-medium text-gray-900 mb-1">{title}</h3>
      <p className="text-sm text-gray-500">{description}</p>
    </div>
  );
}

export default App;
