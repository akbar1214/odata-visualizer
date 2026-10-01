import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The rendered text of a tool result's first content block.
 *
 * `CallToolResult.content` is an array of content blocks and only a text block
 * carries `text`, so reaching for `.text` directly does not typecheck against
 * the SDK union. Every assertion in these suites is about the text a tool
 * rendered, so this narrows honestly: a non-text block (or no content at all)
 * fails the test with a message rather than reading an unrelated field.
 *
 * An empty text block still returns `''`, so a `not.toContain` assertion on
 * its own can pass vacuously here; pair it with a positive assertion when the
 * point is that a tool did render something.
 */
export function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== 'text') {
    throw new Error(
      `Expected a text content block, got ${block ? `"${block.type}"` : 'no content'}`,
    );
  }
  return block.text;
}
