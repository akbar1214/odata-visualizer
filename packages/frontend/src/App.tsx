import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MetadataInput } from './components/MetadataInput';
import { DiagramPage } from './pages/DiagramPage';
import { QueryBuilderPage } from './pages/QueryBuilderPage';
import { useMetadata } from './hooks/useMetadata';

function App() {
  const {
    metadata,
    loading,
    error,
    parseTimeMs,
    fileSizeBytes,
    loadFile,
    loadUrl,
    clear,
  } = useMetadata();

  if (!metadata) {
    return (
      <div className="min-h-screen bg-engineering-100">
        {/* Header */}
        <header className="bg-engineering-600 text-white shadow-odv">
          <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary-500 rounded flex items-center justify-center">
                <span className="text-white font-bold text-sm">OD</span>
              </div>
              <h1 className="text-xl font-semibold">OData Visualizer</h1>
            </div>
          </div>
        </header>

        {/* Input View */}
        <main className="max-w-full mx-auto p-4">
          <div className="max-w-xl mx-auto mt-12">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-black mb-2">
                Visualize OData Metadata
              </h2>
              <p className="text-engineering-500">
                Upload an OData metadata file or provide a URL to generate an interactive
                entity-relationship diagram and build OData queries.
              </p>
            </div>

            <MetadataInput
              onFileSelect={loadFile}
              onUrlSubmit={loadUrl}
              loading={loading}
            />

            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-infineon-red/20 rounded">
                <div className="flex items-start gap-3">
                  <svg
                    className="w-5 h-5 text-infineon-red mt-0.5"
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
                    <h3 className="text-sm font-medium text-infineon-red-dark">Error</h3>
                    <p className="text-sm text-infineon-red mt-1">{error}</p>
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
                title="Query Builder"
                description="Build OData queries interactively with type-aware filters and sorting"
                icon={
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                    />
                  </svg>
                }
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <DiagramPage
              metadata={metadata}
              parseTimeMs={parseTimeMs}
              fileSizeBytes={fileSizeBytes}
              onClear={clear}
            />
          }
        />
        <Route
          path="/query"
          element={<QueryBuilderPage metadata={metadata} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
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
      <div className="w-12 h-12 bg-primary-100 text-primary-600 rounded flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="font-medium text-black mb-1">{title}</h3>
      <p className="text-sm text-engineering-500">{description}</p>
    </div>
  );
}

export default App;
