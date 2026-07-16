import { Link } from 'react-router-dom';
import type { ODataMetadata } from '@odata-visualizer/shared';
import { QueryBuilder } from '../components/QueryBuilder';

interface QueryBuilderPageProps {
  metadata: ODataMetadata;
}

export function QueryBuilderPage({ metadata }: QueryBuilderPageProps) {
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b shadow-sm flex-shrink-0">
        <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="text-gray-500 hover:text-gray-700 text-sm flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Diagram
            </Link>
            <div className="h-6 w-px bg-gray-300" />
            <h1 className="text-lg font-semibold text-gray-900">Query Builder</h1>
          </div>

          <div className="flex items-center gap-4 text-sm text-gray-500">
            <span>{metadata.entities.length} entities</span>
            <span>{metadata.relationships.length} relationships</span>
          </div>
        </div>
      </header>

      {/* Query Builder */}
      <main className="flex-1 overflow-hidden">
        <QueryBuilder metadata={metadata} />
      </main>
    </div>
  );
}
