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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
    );

    // Switch to URL mode
    fireEvent.click(screen.getByText('Enter URL'));

    // Now re-render with loading=true
    rerender(
      <MetadataInput
        onFileSelect={mockOnFileSelect}
        onUrlSubmit={mockOnUrlSubmit}
        loading={true}
      />,
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
      />,
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
      />,
    );

    // Find the hidden file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeDefined();

    const file = new File(['<xml>test</xml>'], 'test.xml', { type: 'application/xml' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(mockOnFileSelect).toHaveBeenCalledWith(file);
  });

  describe('request headers', () => {
    const HEADERS_LABEL = 'Request headers (JSON, optional)';

    function renderUrlMode() {
      render(
        <MetadataInput
          onFileSelect={mockOnFileSelect}
          onUrlSubmit={mockOnUrlSubmit}
          loading={false}
        />,
      );
      fireEvent.click(screen.getByText('Enter URL'));
      fireEvent.change(screen.getByLabelText('OData Metadata URL'), {
        target: { value: 'https://example.com/$metadata' },
      });
    }

    function typeHeaders(value: string) {
      fireEvent.change(screen.getByLabelText(HEADERS_LABEL), { target: { value } });
    }

    function submit() {
      fireEvent.click(screen.getByText('Fetch Metadata'));
    }

    it('is absent in file mode', () => {
      render(
        <MetadataInput
          onFileSelect={mockOnFileSelect}
          onUrlSubmit={mockOnUrlSubmit}
          loading={false}
        />,
      );

      expect(screen.queryByLabelText(HEADERS_LABEL)).toBeNull();
    });

    it('passes a valid JSON object to onUrlSubmit', () => {
      renderUrlMode();
      typeHeaders('{ "Authorization": "Bearer tok" }');

      submit();

      expect(mockOnUrlSubmit).toHaveBeenCalledWith('https://example.com/$metadata', {
        Authorization: 'Bearer tok',
      });
    });

    it('submits without headers when the textarea is empty', () => {
      renderUrlMode();

      submit();

      expect(mockOnUrlSubmit).toHaveBeenCalledWith('https://example.com/$metadata');
    });

    it('submits without headers when the textarea is only whitespace', () => {
      renderUrlMode();
      typeHeaders('   \n  ');

      submit();

      expect(mockOnUrlSubmit).toHaveBeenCalledWith('https://example.com/$metadata');
    });

    it('submits an empty JSON object as an empty header set', () => {
      renderUrlMode();
      typeHeaders('{}');

      submit();

      expect(mockOnUrlSubmit).toHaveBeenCalledWith('https://example.com/$metadata', {});
    });

    it('reports malformed JSON inline and does not submit', () => {
      renderUrlMode();
      typeHeaders('{ "Authorization": ');

      submit();

      expect(screen.getByRole('alert').textContent).toMatch(/valid JSON/i);
      expect(mockOnUrlSubmit).not.toHaveBeenCalled();
    });

    it.each(['[]', '[{ "Authorization": "Bearer tok" }]', '42', '"Bearer tok"', 'null'])(
      'reports %s inline and does not submit',
      (value) => {
        renderUrlMode();
        typeHeaders(value);

        submit();

        expect(screen.getByRole('alert').textContent).toMatch(/must be a JSON object/i);
        expect(mockOnUrlSubmit).not.toHaveBeenCalled();
      },
    );

    it('reports a non-string header value inline and does not submit', () => {
      renderUrlMode();
      typeHeaders('{ "Authorization": 42 }');

      submit();

      expect(screen.getByRole('alert').textContent).toMatch(/must be strings/i);
      expect(mockOnUrlSubmit).not.toHaveBeenCalled();
    });

    it('clears the error once the headers become valid', () => {
      renderUrlMode();
      typeHeaders('nope');
      submit();
      expect(screen.getByRole('alert')).toBeDefined();

      typeHeaders('{ "Authorization": "Bearer tok" }');
      submit();

      expect(screen.queryByRole('alert')).toBeNull();
      expect(mockOnUrlSubmit).toHaveBeenCalledWith('https://example.com/$metadata', {
        Authorization: 'Bearer tok',
      });
    });

    it('keeps a __proto__ header name as an own property', () => {
      // `JSON.parse` is how the value really arrives: it defines an own
      // `__proto__` data property, which a plain assignment drops.
      let captured: Record<string, string> = {};
      const onUrlSubmit = vi.fn((_url: string, headers?: Record<string, string>) => {
        if (headers) captured = headers;
      });

      render(
        <MetadataInput onFileSelect={mockOnFileSelect} onUrlSubmit={onUrlSubmit} loading={false} />,
      );
      fireEvent.click(screen.getByText('Enter URL'));
      fireEvent.change(screen.getByLabelText('OData Metadata URL'), {
        target: { value: 'https://example.com/$metadata' },
      });
      fireEvent.change(screen.getByLabelText(HEADERS_LABEL), {
        target: { value: '{ "__proto__": "x", "Authorization": "Bearer tok" }' },
      });
      fireEvent.click(screen.getByText('Fetch Metadata'));

      expect(onUrlSubmit).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn(captured, '__proto__')).toBe(true);
      expect(captured['__proto__']).toBe('x');
      expect(captured['Authorization']).toBe('Bearer tok');
      expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    });

    it('never writes the headers text to web storage', () => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      renderUrlMode();
      typeHeaders('{ "Authorization": "Bearer sekret" }');

      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    });
  });
});
