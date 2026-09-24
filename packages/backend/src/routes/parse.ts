import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import multer from 'multer';
import { parseCSDL } from '@odata-visualizer/shared';
import { metadataStore, sanitizeModelId } from '../services/metadataStore.js';
import { createHttpReferenceLoader } from '../services/referenceLoader.js';
import { validateMetadataUrl } from '../services/urlPolicy.js';
import type { ParseRequest, ParseResponse } from '@odata-visualizer/shared';

const router: ExpressRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['application/xml', 'text/xml', 'application/octet-stream'];
    if (
      allowedMimes.includes(file.mimetype) ||
      file.originalname.endsWith('.xml') ||
      file.originalname.endsWith('.csdl') ||
      file.originalname.endsWith('.edmx')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only XML files are allowed.'));
    }
  },
});

/** Session id for per-browser isolation; falls back to the shared "current" model. */
function sessionIdOf(req: Request, body?: { session?: string }): string {
  const fromHeader = req.headers['x-metadata-session'];
  const headerValue = typeof fromHeader === 'string' ? fromHeader : undefined;
  const raw = headerValue ?? body?.session;
  return raw ? sanitizeModelId(raw) : 'default';
}

/**
 * Keep the URL safe to display and hand to an MCP client by stripping any
 * embedded password.
 */
function redactUrlCredentials(url: URL): string {
  if (!url.password) return url.toString();
  const redacted = new URL(url.toString());
  redacted.password = '';
  return redacted.toString();
}

function allowlistFromEnv(): string[] | undefined {
  const raw = process.env['METADATA_URL_ALLOWLIST'];
  if (!raw) return undefined;
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

function blockPrivateFromEnv(): boolean {
  return process.env['METADATA_URL_BLOCK_PRIVATE'] !== '0';
}

/**
 * Parse an uploaded/POSTed document. When the caller supplies a `baseUrl`,
 * `edmx:Reference/@Uri` values are fetched relative to it (browser uploads
 * have no filesystem base of their own).
 */
async function parseUploadedDocument(
  xmlContent: string,
  baseUrl: string | undefined,
): Promise<Awaited<ReturnType<typeof parseCSDL>>> {
  if (!baseUrl) return parseCSDL(xmlContent);

  const base = validateMetadataUrl(baseUrl, allowlistFromEnv(), {
    blockPrivate: blockPrivateFromEnv(),
  });
  return parseCSDL(xmlContent, {
    baseUri: base.toString(),
    loadExternal: createHttpReferenceLoader(),
  });
}

/**
 * POST /api/parse/file
 * Parse OData metadata from uploaded file
 */
router.post('/file', upload.single('metadata'), async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    if (!req.file) {
      const response: ParseResponse = {
        success: false,
        error: 'No file uploaded',
        parseTimeMs: Date.now() - startTime,
        fileSizeBytes: 0,
      };
      res.status(400).json(response);
      return;
    }

    const xmlContent = req.file.buffer.toString('utf-8');
    const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : undefined;
    const data = await parseUploadedDocument(xmlContent, baseUrl);

    metadataStore.save(sessionIdOf(req), data, {
      sourceName: req.file.originalname,
      sourceType: 'file',
      fileSizeBytes: req.file.size,
    });

    const response: ParseResponse = {
      success: true,
      data,
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: req.file.size,
    };

    res.json(response);
  } catch (error) {
    const response: ParseResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: req.file?.size || 0,
    };

    res.status(500).json(response);
  }
});

/**
 * POST /api/parse/url
 * Parse OData metadata from URL
 */
router.post('/url', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { url } = req.body as ParseRequest;

    if (!url) {
      const response: ParseResponse = {
        success: false,
        error: 'No URL provided',
        parseTimeMs: Date.now() - startTime,
        fileSizeBytes: 0,
      };
      res.status(400).json(response);
      return;
    }

    // Restrict what the server will fetch (SSRF guard).
    let parsedUrl: URL;
    try {
      parsedUrl = validateMetadataUrl(url, allowlistFromEnv(), {
        blockPrivate: blockPrivateFromEnv(),
      });
    } catch (error) {
      const response: ParseResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid URL',
        parseTimeMs: Date.now() - startTime,
        fileSizeBytes: 0,
      };
      res.status(400).json(response);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    // Credentials embedded in a URL are not a supported auth mechanism (and
    // fetch rejects them), so they are stripped before the request.
    const safeUrl = redactUrlCredentials(parsedUrl);

    try {
      const response = await fetch(safeUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/xml, text/xml, application/atomsvc+xml',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorResponse: ParseResponse = {
          success: false,
          error: `Failed to fetch metadata: HTTP ${response.status} ${response.statusText}`,
          parseTimeMs: Date.now() - startTime,
          fileSizeBytes: 0,
        };
        res.status(502).json(errorResponse);
        return;
      }

      // fetch follows redirects, so a validated public URL can end up pointing
      // at a private address. Re-check where the response actually came from.
      if (response.url) {
        try {
          validateMetadataUrl(response.url, allowlistFromEnv(), {
            blockPrivate: blockPrivateFromEnv(),
          });
        } catch (error) {
          const rejected: ParseResponse = {
            success: false,
            error: `Refusing metadata from ${response.url}: ${
              error instanceof Error ? error.message : 'blocked by policy'
            }`,
            parseTimeMs: Date.now() - startTime,
            fileSizeBytes: 0,
          };
          res.status(400).json(rejected);
          return;
        }
      }

      const xmlContent = await response.text();
      const contentLength = response.headers.get('content-length');
      const fileSizeBytes = contentLength ? parseInt(contentLength, 10) : xmlContent.length;

      // Parse the document we already fetched (a second fetch could return a
      // different document than the one whose size was reported), and resolve
      // references through the same URL policy.
      const data = await parseCSDL(xmlContent, {
        baseUri: safeUrl,
        loadExternal: createHttpReferenceLoader(),
      });

      metadataStore.save(sessionIdOf(req), data, {
        sourceName: safeUrl,
        sourceType: 'url',
        fileSizeBytes,
      });

      const result: ParseResponse = {
        success: true,
        data,
        parseTimeMs: Date.now() - startTime,
        fileSizeBytes,
      };

      res.json(result);
    } catch (fetchError) {
      clearTimeout(timeout);
      throw fetchError;
    }
  } catch (error) {
    let errorMessage = 'Unknown error occurred';
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        errorMessage = 'Request timed out after 30 seconds';
      } else {
        errorMessage = error.message;
      }
    }

    const response: ParseResponse = {
      success: false,
      error: errorMessage,
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: 0,
    };

    res.status(500).json(response);
  }
});

/**
 * POST /api/parse/content
 * Parse OData metadata from raw XML content
 */
router.post('/content', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { content, session, baseUrl } = req.body as {
      content?: string;
      session?: string;
      baseUrl?: string;
    };

    if (!content) {
      const response: ParseResponse = {
        success: false,
        error: 'No XML content provided',
        parseTimeMs: Date.now() - startTime,
        fileSizeBytes: 0,
      };
      res.status(400).json(response);
      return;
    }

    const data = await parseUploadedDocument(content, baseUrl);

    metadataStore.save(sessionIdOf(req, { session }), data, {
      sourceName: 'inline content',
      sourceType: 'content',
      fileSizeBytes: content.length,
    });

    const response: ParseResponse = {
      success: true,
      data,
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: content.length,
    };

    res.json(response);
  } catch (error) {
    const response: ParseResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: 0,
    };

    res.status(500).json(response);
  }
});

export { router as parseRouter };
