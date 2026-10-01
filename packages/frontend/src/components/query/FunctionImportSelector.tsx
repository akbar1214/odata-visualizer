import { useState, useMemo, useCallback } from 'react';
import {
  encodeIdentifierForUrl,
  encodeLiteralForUrl,
  IDENTIFIER_UNSAFE,
  PATH_UNSAFE,
  type ODataMetadata,
} from '@odata-visualizer/shared';
import { formatODataValue } from '../../utils/queryResolver';

/**
 * The shared path set plus `&`: the selector's output is copied as a fragment
 * and may be read as a query string, where a raw `&` splits the value off as a
 * separate parameter.
 */
const FUNCTION_VALUE_UNSAFE: ReadonlySet<string> = new Set([...PATH_UNSAFE, '&']);

/**
 * The same rationale for identifier positions (parameter and import names):
 * MCP emits a whole URL and keeps the shared identifier policy, but a copied
 * fragment is re-read as a query string, so a metadata name such as `A&B` must
 * not be able to split it. `#` and the OData structure characters are already
 * in `IDENTIFIER_UNSAFE`.
 */
const FUNCTION_IDENTIFIER_UNSAFE: ReadonlySet<string> = new Set([...IDENTIFIER_UNSAFE, '&']);

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
    [functionImports, selectedFunction],
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
        // The same literal and encoding path as MCP's inline parameters: the
        // shared formatter doubles a quote (`O'Brien` -> `'O''Brien'`) and the
        // shared encoder keeps a space, `&` or `#` inside the value.
        const literal = formatODataValue(value, param.type);
        paramParts.push(
          `${encodeIdentifierForUrl(param.name, FUNCTION_IDENTIFIER_UNSAFE)}=${encodeLiteralForUrl(literal, FUNCTION_VALUE_UNSAFE)}`,
        );
      }
      // An empty input cannot be told apart from an untouched one, so an empty
      // value is left out; when it is a function's only parameter the preview
      // collapses to the no-parameter shape. MCP receives values explicitly and
      // renders `Name=''` for an empty string — this is the one documented
      // divergence, pinned in `functionImportSelector.test.tsx`.
    }

    const queryString = paramParts.length > 0 ? `(${paramParts.join(',')})` : '';
    // An unbound function is addressed by its import name, and the selector's
    // options come from `metadata.functionImports`, so `name` is that name.
    return `/${encodeIdentifierForUrl(selectedFunc.name, FUNCTION_IDENTIFIER_UNSAFE)}${queryString}`;
  };

  const handleFunctionChangeEvent = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    handleFunctionChange(e.target.value);
  }, []);

  const handleParamChangeEvent = useCallback(
    (paramName: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
      handleParamChange(paramName, e.target.value);
    },
    [],
  );

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
        onChange={handleFunctionChangeEvent}
      >
        <option value="">Select function...</option>
        {functionImports.map((func) => (
          <option key={func.name} value={func.name}>
            {func.name}
            {func.parameter?.length ? '(...)' : '()'}
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
                  <label
                    className="text-[10px] text-engineering-500 w-20 truncate"
                    title={param.name}
                  >
                    {param.name}
                  </label>
                  <input
                    type="text"
                    className="input text-[10px] flex-1 py-1"
                    placeholder={param.type.replace('Edm.', '')}
                    value={paramValues[param.name] || ''}
                    onChange={handleParamChangeEvent(param.name)}
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
