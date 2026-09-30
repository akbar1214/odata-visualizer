import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface QueryPreviewProps {
  query: string;
  /** Shown in place of the query when there is nothing to build. */
  emptyMessage?: string;
  /**
   * Problems the builder reported for `query`, listed under the preview.
   * Messages marked as omitted rows describe filters that are missing from the
   * query; the shared builder also reports rows it *kept* but could not
   * resolve (a property the model does not have), which the UI's
   * model-derived dropdowns cannot produce today.
   */
  warnings?: string[];
  /** Filter rows left out of `query`; the Copy label has to say so. */
  omittedFilterCount?: number;
}

const COPIED_FEEDBACK_MS = 2000;

const DEFAULT_EMPTY_MESSAGE = 'Select an entity to generate a query';

/**
 * The part of a warning that is stable while the user types.
 *
 * Each visible message ends with the formatter's reason, which embeds the raw
 * value (`…: Invalid Edm.Guid value: abc`). A live region bound to the full
 * text announced a new message for every keystroke, so the announcement keeps
 * only the prefix (property, operator, problem) and leaves the changing value
 * and reason to the visible list.
 */
function announcementFor(warning: string): string {
  const separator = warning.indexOf(': ');
  return separator === -1 ? warning : warning.slice(0, separator);
}

export function QueryPreview({
  query,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  warnings = [],
  omittedFilterCount = 0,
}: QueryPreviewProps) {
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

  // Unique per message, and derived from data rather than position, so the
  // same warning keeps its DOM node when the list is reordered.
  const uniqueWarnings = useMemo(() => [...new Set(warnings)], [warnings]);

  // A user copying the query copies a valid query that silently omits rows;
  // the Copy affordance is where that has to be visible.
  const omittedSuffix =
    omittedFilterCount > 0
      ? ` (${omittedFilterCount} filter${omittedFilterCount === 1 ? '' : 's'} omitted)`
      : '';

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
              Copied{omittedSuffix}
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
              Copy{omittedSuffix}
            </>
          )}
        </button>
      </div>

      <pre className="bg-engineering-600 text-primary-200 rounded p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all min-h-[60px]">
        {query || emptyMessage}
      </pre>

      {/* Kept mounted (empty when there is nothing to say) so assistive
          technology announces rows appearing and disappearing. The list below
          carries the full reasons; this region carries only their stable
          prefixes, so typing inside a bad value does not re-announce. */}
      <p aria-live="polite" aria-label="Query warnings" className="sr-only">
        {uniqueWarnings.map(announcementFor).join('; ')}
      </p>

      {/* amber-600 on amber-50 is 3.07:1 at this size; amber-700 is 4.84:1.
          `break-all` keeps a long unbroken value from widening the panel. */}
      <ul
        className={
          uniqueWarnings.length > 0
            ? 'mt-2 space-y-1 text-xs text-amber-700 bg-amber-50 p-2 rounded break-all'
            : undefined
        }
      >
        {uniqueWarnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}
