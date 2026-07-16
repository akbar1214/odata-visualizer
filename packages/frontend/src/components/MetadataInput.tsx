import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from 'react';

type InputMode = 'file' | 'url';

interface MetadataInputProps {
  onFileSelect: (file: File) => void;
  onUrlSubmit: (url: string) => void;
  loading: boolean;
}

export function MetadataInput({ onFileSelect, onUrlSubmit, loading }: MetadataInputProps) {
  const [mode, setMode] = useState<InputMode>('file');
  const [url, setUrl] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      if (loading) return;

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (isValidXmlFile(file)) {
          setSelectedFile(file);
          onFileSelect(file);
        }
      }
    },
    [loading, onFileSelect]
  );

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (isValidXmlFile(file)) {
          setSelectedFile(file);
          onFileSelect(file);
        }
      }
    },
    [onFileSelect]
  );

  const handleUrlSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (url.trim() && !loading) {
        onUrlSubmit(url.trim());
      }
    },
    [url, loading, onUrlSubmit]
  );

  const isValidXmlFile = (file: File): boolean => {
    const validTypes = ['application/xml', 'text/xml', 'application/octet-stream'];
    const validExtensions = ['.xml', '.csdl', '.edmx'];
    
    const hasValidType = validTypes.includes(file.type);
    const hasValidExtension = validExtensions.some((ext) =>
      file.name.toLowerCase().endsWith(ext)
    );

    return hasValidType || hasValidExtension;
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold text-black mb-4">Load OData Metadata</h2>

      {/* Mode Toggle */}
      <div className="flex gap-2 mb-4">
        <button
          type="button"
          onClick={() => {
            setMode('file');
            setTimeout(() => fileInputRef.current?.click(), 0);
          }}
          className={`btn ${mode === 'file' ? 'btn-primary' : 'btn-secondary'}`}
          disabled={loading}
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
          Upload File
        </button>
        <button
          type="button"
          onClick={() => setMode('url')}
          className={`btn ${mode === 'url' ? 'btn-primary' : 'btn-secondary'}`}
          disabled={loading}
        >
          <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            />
          </svg>
          Enter URL
        </button>
      </div>

      {/* File Upload Mode */}
      {mode === 'file' && (
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          className={`relative border-2 border-dashed rounded p-8 text-center transition-colors ${
            dragActive
              ? 'border-primary-500 bg-primary-100'
              : 'border-engineering-300 hover:border-engineering-400 hover:bg-engineering-100'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.csdl,.edmx"
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            disabled={loading}
          />
          
          {selectedFile ? (
            <div className="space-y-2">
              <svg
                className="w-12 h-12 mx-auto text-infineon-green"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm font-medium text-black">{selectedFile.name}</p>
              <p className="text-xs text-engineering-500">{formatFileSize(selectedFile.size)}</p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedFile(null);
                  fileInputRef.current?.click();
                }}
                className="text-sm text-primary-500 hover:text-primary-600"
                disabled={loading}
              >
                Choose different file
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <svg
                className="w-12 h-12 mx-auto text-engineering-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <p className="text-sm text-engineering-500">
                Drag and drop your OData metadata file here, or{' '}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className="text-primary-500 hover:text-primary-600 font-medium"
                  disabled={loading}
                >
                  browse
                </button>
              </p>
              <p className="text-xs text-engineering-400">Supports XML, CSDL, EDMX files up to 100MB</p>
            </div>
          )}
        </div>
      )}

      {/* URL Input Mode */}
      {mode === 'url' && (
        <form onSubmit={handleUrlSubmit} className="space-y-4">
          <div>
            <label htmlFor="metadata-url" className="block text-sm font-medium text-engineering-600 mb-1">
              OData Metadata URL
            </label>
            <input
              id="metadata-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://services.odata.org/V4/OData/OData.svc/$metadata"
              className="input"
              disabled={loading}
            />
          </div>
          <p className="text-xs text-engineering-400">
            Enter the URL to an OData $metadata endpoint. The backend will fetch the metadata to
            avoid CORS issues.
          </p>
          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading || !url.trim()}
          >
            {loading ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Fetching Metadata...
              </>
            ) : (
              'Fetch Metadata'
            )}
          </button>
        </form>
      )}

      {/* Loading Indicator */}
      {loading && mode === 'file' && (
        <div className="mt-4 flex items-center justify-center text-sm text-engineering-500">
          <svg
            className="animate-spin -ml-1 mr-2 h-4 w-4 text-primary-500"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          Parsing metadata...
        </div>
      )}
    </div>
  );
}
