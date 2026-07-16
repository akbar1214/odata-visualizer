import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MetadataInput } from '../src/components/MetadataInput';

describe('MetadataInput', () => {
  const mockOnFileSelect = vi.fn();
  const mockOnUrlSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders file upload mode by default', () => {
    render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={false}
      />
    );

    expect(screen.getByText('Upload File')).toBeDefined();
    expect(screen.getByText('Enter URL')).toBeDefined();
    expect(screen.getByText(/Drag and drop/)).toBeDefined();
  });

  it('switches to URL mode when Enter URL button is clicked', () => {
    render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={false}
      />
    );

    fireEvent.click(screen.getByText('Enter URL'));

    expect(screen.getByLabelText('OData Metadata URL')).toBeDefined();
    expect(screen.getByText('Fetch Metadata')).toBeDefined();
  });

  it('calls onUrlSubmit with URL when form is submitted', () => {
    render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={false}
      />
    );

    fireEvent.click(screen.getByText('Enter URL'));

    const urlInput = screen.getByLabelText('OData Metadata URL');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/$metadata' } });

    fireEvent.click(screen.getByText('Fetch Metadata'));

    expect(mockOnUrlSubmit).toHaveBeenCalledWith('https://example.com/$metadata');
  });

  it('disables controls when loading', () => {
    render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={true}
      />
    );

    const uploadBtn = screen.getByText('Upload File').closest('button');
    const urlBtn = screen.getByText('Enter URL').closest('button');
    
    expect(uploadBtn?.disabled).toBe(true);
    expect(urlBtn?.disabled).toBe(true);
  });

  it('shows loading state in URL mode', () => {
    // First render in URL mode with loading
    const { rerender } = render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={false}
      />
    );

    // Switch to URL mode
    fireEvent.click(screen.getByText('Enter URL'));

    // Now re-render with loading=true
    rerender(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={true}
      />
    );

    // Check for loading indicator text
    expect(screen.getByText(/Fetching Metadata/)).toBeDefined();
  });

  it('does not submit empty URL', () => {
    render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={false}
      />
    );

    fireEvent.click(screen.getByText('Enter URL'));
    fireEvent.click(screen.getByText('Fetch Metadata'));

    expect(mockOnUrlSubmit).not.toHaveBeenCalled();
  });

  it('handles file input change', () => {
    render(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={false}
      />
    );

    // Find the hidden file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeDefined();

    const file = new File(['<xml>test</xml>'], 'test.xml', { type: 'application/xml' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(mockOnFileSelect).toHaveBeenCalledWith(file);
  });
});
