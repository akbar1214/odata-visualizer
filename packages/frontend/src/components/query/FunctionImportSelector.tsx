import { useState, useMemo } from 'react';
import type { ODataMetadata } from '@odata-visualizer/shared';

interface FunctionImportSelectorProps {
  metadata: ODataMetadata;
  onSelect: (query: string) => void;
}

export function FunctionImportSelector({ metadata, onSelect }: FunctionImportSelectorProps) {
  const [selectedFunction, setSelectedFunction] = useState<string>('');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const functionImports = useMemo(() => metadata.functionImports || [], [metadata]);

  const selectedFunc = useMemo(
    () => functionImports.find((f) => f.name === selectedFunction),
    [functionImports, selectedFunction]
  );

  const handleFunctionChange = (funcName: string) => {
    setSelectedFunction(funcName);
    setParamValues({});
  };

  const handleParamChange = (paramName: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [paramName]: value }));
  };

  const buildFunctionQuery = (): string => {
    if (!selectedFunc) return '';

    const params = selectedFunc.parameter || [];
    const paramParts: string[] = [];

    for (const param of params) {
      const value = paramValues[param.name];
      if (value !== undefined && value !== '') {
        // Format value based on type
        let formattedValue = value;
        if (param.type === 'Edm.String') {
          formattedValue = `'${value}'`;
        } else if (param.type === 'Edm.Boolean') {
          formattedValue = value.toLowerCase() === 'true' ? 'true' : 'false';
        }
        paramParts.push(`${param.name}=${formattedValue}`);
      }
    }

    const queryString = paramParts.length > 0 ? `(${paramParts.join(',')})` : '';
    return `${selectedFunc.name}${queryString}`;
  };

  const handleExecute = () => {
    const query = buildFunctionQuery();
    if (query) {
      onSelect(query);
    }
  };

  if (functionImports.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-engineering-500">Function Imports</div>

      <select
        className="input text-xs w-full"
        value={selectedFunction}
        onChange={(e) => handleFunctionChange(e.target.value)}
      >
        <option value="">Select function...</option>
        {functionImports.map((func) => (
          <option key={func.name} value={func.name}>
            {func.name}{func.parameter?.length ? '(...)' : '()'}
          </option>
        ))}
      </select>

      {selectedFunc && (
        <div className="space-y-2">
          {/* Return type info */}
          {selectedFunc.returnType && (
            <div className="text-[10px] text-engineering-400">
              Returns: <span className="text-primary-500 font-mono">{selectedFunc.returnType}</span>
            </div>
          )}

          {/* Parameters */}
          {selectedFunc.parameter && selectedFunc.parameter.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-engineering-400">Parameters:</div>
              {selectedFunc.parameter.map((param) => (
                <div key={param.name} className="flex items-center gap-2">
                  <label className="text-[10px] text-engineering-500 w-20 truncate" title={param.name}>
                    {param.name}
                  </label>
                  <input
                    type="text"
                    className="input text-[10px] flex-1 py-1"
                    placeholder={param.type.replace('Edm.', '')}
                    value={paramValues[param.name] || ''}
                    onChange={(e) => handleParamChange(param.name, e.target.value)}
                  />
                  <span className="text-[9px] text-engineering-400 w-12 truncate">
                    {param.type.replace('Edm.', '')}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Preview and Execute */}
          <div className="pt-2 border-t border-engineering-200">
            <div className="text-[10px] text-engineering-400 mb-1">Preview:</div>
            <div className="text-[10px] font-mono text-primary-500 bg-engineering-100 rounded p-1.5 mb-2 break-all">
              {buildFunctionQuery() || '(no query)'}
            </div>
            <button
              onClick={handleExecute}
              disabled={!selectedFunction}
              className="w-full px-3 py-1.5 bg-primary-500 text-white text-xs rounded hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add to Canvas
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
