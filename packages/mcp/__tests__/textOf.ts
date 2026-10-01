import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The rendered text of a tool result's first content block.
 *
 * `CallToolResult.content` is an array of content blocks and only a text block
 * carries `text`, so reaching for `.text` directly does not typecheck against
 * the SDK union. Every assertion in these suites is about the text a tool
 * rendered, so this narrows honestly: a non-text block (or no content at all)
 * fails the test with a message instead of producing a value that could satisfy
 * an assertion vacuously.
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
