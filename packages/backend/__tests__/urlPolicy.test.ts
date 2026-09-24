import { describe, it, expect } from 'vitest';
import { validateMetadataUrl } from '../src/services/urlPolicy.js';

describe('validateMetadataUrl', () => {
  it('accepts http(s) URLs when no allowlist is configured', () => {
    expect(() => validateMetadataUrl('https://windchill.example.com/odata/$metadata')).not.toThrow();
    expect(() => validateMetadataUrl('http://windchill.example.com/odata/$metadata')).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => validateMetadataUrl('file:///etc/passwd')).toThrow(/scheme/i);
    expect(() => validateMetadataUrl('ftp://host/$metadata')).toThrow(/scheme/i);
    expect(() => validateMetadataUrl('gopher://host/')).toThrow(/scheme/i);
  });

  it('enforces an allowlist when provided', () => {
    const allow = ['windchill.example.com', '*.internal.example'];
    expect(() =>
      validateMetadataUrl('https://windchill.example.com/$metadata', allow),
    ).not.toThrow();
    expect(() => validateMetadataUrl('https://a.internal.example/$metadata', allow)).not.toThrow();
    expect(() => validateMetadataUrl('https://evil.example.com/$metadata', allow)).toThrow(
      /not allowed/i,
    );
  });

  it('optionally blocks private and loopback addresses', () => {
    expect(() =>
      validateMetadataUrl('http://127.0.0.1:8080/$metadata', undefined, { blockPrivate: true }),
    ).toThrow(/private|loopback/i);
    expect(() =>
      validateMetadataUrl('http://10.1.2.3/$metadata', undefined, { blockPrivate: true }),
    ).toThrow(/private|loopback/i);
    expect(() =>
      validateMetadataUrl('http://[::1]/odata', undefined, { blockPrivate: true }),
    ).toThrow(/private|loopback/i);
    expect(() =>
      validateMetadataUrl('http://169.254.169.254/latest/meta-data', undefined, {
        blockPrivate: true,
      }),
    ).toThrow(/private|loopback/i);
    expect(() =>
      validateMetadataUrl('https://windchill.example.com/$metadata', undefined, {
        blockPrivate: true,
      }),
    ).not.toThrow();
  });

  it('allows private addresses by default so internal services work', () => {
    expect(() => validateMetadataUrl('http://windchill.corp.local/$metadata')).not.toThrow();
  });
});
