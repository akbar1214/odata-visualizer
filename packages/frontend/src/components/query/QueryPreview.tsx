import { useCallback, useEffect, useRef, useState } from 'react';

interface QueryPreviewProps {
  query: string;
  /** Shown in place of the query when there is nothing to build. */
  emptyMessage?: string;
}

const COPIED_FEEDBACK_MS = 2000;

const DEFAULT_EMPTY_MESSAGE = 'Select an entity to generate a query';

export function QueryPreview({ query, emptyMessage = DEFAULT_EMPTY_MESSAGE }: QueryPreviewProps) {
  const [copied, setCopied] = useState(false);
  // Held so repeated clicks reuse one timer instead of stacking one per click
  // (a stale timer reset the "Copied" state early) and so unmount can clear it.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const showCopied = useCallback(() => {
    setCopied(true);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(query);
      showCopied();
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = query;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showCopied();
    }
  }, [query, showCopied]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-engineering-500">Generated Query</label>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs text-primary-500 hover:text-primary-600 flex items-center gap-1"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>

      <pre className="bg-engineering-600 text-primary-200 rounded p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all min-h-[60px]">
        {query || emptyMessage}
      </pre>
    </div>
  );
}
