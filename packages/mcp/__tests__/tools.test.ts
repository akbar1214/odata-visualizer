import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { handleToolCall, getMetadata, resetMetadata } from '../src/tools.js';

const fixturePath = fileURLToPath(new URL('./fixtures/sample-metadata.xml', import.meta.url));

describe('MCP tool handlers', () => {
  beforeEach(() => {
    resetMetadata();
  });

  it('returns isError when load_metadata is missing source', async () => {
    const result = await handleToolCall('load_metadata', { type: 'file' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('source is required');
  });

  it('returns isError when metadata is not loaded', async () => {
    const result = await handleToolCall('list_entities', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No metadata loaded');
  });

  it('returns isError for unknown tool', async () => {
    const result = await handleToolCall('does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('loads metadata from a file and lists entities', async () => {
    const loadResult = await handleToolCall('load_metadata', {
      source: fixturePath,
      type: 'file',
    });
    expect(loadResult.isError).toBeUndefined();
    expect(loadResult.content[0].text).toContain('Successfully loaded');
    expect(getMetadata()?.entities).toHaveLength(2);

    const listResult = await handleToolCall('list_entities', {});
    expect(listResult.isError).toBeUndefined();
    expect(listResult.content[0].text).toContain('Product');
    expect(listResult.content[0].text).toContain('Category');
  });

  it('returns entity details including navigation targets', async () => {
    await handleToolCall('load_metadata', { source: fixturePath, type: 'file' });

    const result = await handleToolCall('get_entity_details', { entityName: 'Product' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Entity: Product');
    expect(result.content[0].text).toContain('Category -> Category');
  });

  it('returns isError for unknown entity', async () => {
    await handleToolCall('load_metadata', { source: fixturePath, type: 'file' });

    const result = await handleToolCall('get_entity_details', { entityName: 'Missing' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('derives V4 relationships for get_relationships', async () => {
    await handleToolCall('load_metadata', { source: fixturePath, type: 'file' });

    const result = await handleToolCall('get_relationships', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('relationships');
    expect(result.content[0].text).toContain('Product');
    expect(result.content[0].text).toContain('Category');
  });

  it('returns isError when loading a missing file', async () => {
    const result = await handleToolCall('load_metadata', {
      source: '/nonexistent/metadata.xml',
      type: 'file',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error loading metadata');
  });
});
