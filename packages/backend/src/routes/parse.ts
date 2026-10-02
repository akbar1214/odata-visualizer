import {
  Router,
  type NextFunction,
  type Request,
  type Response,
  type Router as ExpressRouter,
} from 'express';
import multer from 'multer';
import { parseCSDL } from '@odata-visualizer/shared';
import { metadataStore, sanitizeModelId } from '../services/metadataStore.js';
import { createHttpReferenceLoader } from '../services/referenceLoader.js';
import { validateMetadataUrl, UrlPolicyError } from '../services/urlPolicy.js';
import {
  fetchWithPolicy,
  readLimitedText,
  RedirectLimitError,
  urlPolicyFromEnv,
} from '../services/safeFetch.js';
import { ClientError, statusForError } from '../services/errors.js';
import { MAX_UPLOAD_BYTES } from '../services/limits.js';
import type { ParseRequest, ParseResponse } from '@odata-visualizer/shared';

const router: ExpressRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 10,
    parts: 20,
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
      cb(new ClientError('Invalid file type. Only XML files are allowed.', 400));
    }
  },
});

/**
 * Pre-handler middleware for the parse routes, restricted to POST so methods
 * that never had a route (`GET /api/parse/file` and friends) keep returning
 * 404. While `METADATA_FILE` pins the model, POSTs are refused before the
 * route handlers run — and, for multipart, before multer buffers the file.
 * JSON bodies are parsed by `express.json` (10 MB limit) before this
 * middleware, so an over-limit one is a 413 rather than the pinned 403. The
 * body is a `ParseResponse` so existing clients still understand the refusal.
 */
function refuseWhenPinned(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST' || !metadataStore.isLocked()) {
    next();
    return;
  }
  const response: ParseResponse = {
    success: false,
    error: 'Metadata is pinned by METADATA_FILE; uploads are disabled.',
    parseTimeMs: 0,
    fileSizeBytes: 0,
  };
  res.status(403).json(response);
}

// Wired before any route handler, so a pinned POST never reaches multer or a
// URL fetch (JSON bodies are parsed earlier, see the comment above).
router.use(['/file', '/url', '/content'], refuseWhenPinned);

/** Session id for per-browser isolation; falls back to the shared "current" model. */
function sessionIdOf(req: Request, body?: { session?: string }): string {
  const fromHeader = req.headers['x-metadata-session'];
  const headerValue = typeof fromHeader === 'string' ? fromHeader : undefined;
  const raw = headerValue ?? body?.session;
  return raw ? sanitizeModelId(raw) : 'default';
}

/**
 * Keep the URL safe to display and hand to an MCP client.
 *
 * fetch rejects any URL carrying credentials, and `https://token@host/` is a
 * common way to pass an API token — so the username has to go as well as the
 * password, otherwise the fetch fails and the token is echoed in the error.
 */
function redactUrlCredentials(url: URL): string {
  if (!url.username && !url.password) return url.toString();
  const redacted = new URL(url.toString());
  redacted.username = '';
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
 * Parse a CSDL document, reporting a malformed one as a caller error.
 *
 * `parseCSDL` throws plain `Error`s for "not CSDL", which the route would
 * otherwise surface as a 500 — hiding the cause and implying the server broke
 * when the caller simply sent HTML.
 */
async function parseCSDLDocument(
  xmlContent: string,
  options?: Parameters<typeof parseCSDL>[1],
): Promise<Awaited<ReturnType<typeof parseCSDL>>> {
  try {
    return await parseCSDL(xmlContent, options);
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (error instanceof UrlPolicyError) throw error;
    throw new ClientError(
      error instanceof Error ? error.message : 'Could not parse the metadata document',
      400,
    );
  }
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
  if (!baseUrl) return parseCSDLDocument(xmlContent);

  const base = validateMetadataUrl(baseUrl, allowlistFromEnv(), {
    blockPrivate: blockPrivateFromEnv(),
  });
  return parseCSDLDocument(xmlContent, {
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

    metadataStore.save(sessionIdOf(req, req.body as { session?: string }), data, {
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
    // Malformed input is a caller error, not a server fault.
    const status = statusForError(error);
    const response: ParseResponse = {
      success: false,
      error:
        status >= 500
          ? 'Internal server error'
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred',
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: req.file?.size || 0,
    };

    if (status >= 500) console.error('[odata-visualizer] /api/parse/file failed:', error);

    res.status(status).json(response);
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

    // Credentials embedded in a URL are not a supported auth mechanism (and
    // fetch rejects them), so they are stripped before the request.
    const safeUrl = redactUrlCredentials(parsedUrl);

    try {
      // Validates every redirect hop *before* requesting it, so a public URL
      // cannot bounce the server to a private address.
      const response = await fetchWithPolicy(safeUrl, {
        ...urlPolicyFromEnv(),
        accept: 'application/xml, text/xml, application/atomsvc+xml',
      });

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

      const xmlContent = await readLimitedText(response);
      // Content-Length is advisory (and can be absent or malformed), so report
      // the size of the document that was actually parsed.
      const fileSizeBytes = Buffer.byteLength(xmlContent, 'utf8');

      // Parse the document we already fetched (a second fetch could return a
      // different document than the one whose size was reported), and resolve
      // references through the same URL policy.
      const data = await parseCSDLDocument(xmlContent, {
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
      // Policy violations (blocked redirect, bad scheme) are caller errors;
      // a redirect loop is an upstream problem.
      if (fetchError instanceof UrlPolicyError) {
        const rejected: ParseResponse = {
          success: false,
          error: fetchError.message,
          parseTimeMs: Date.now() - startTime,
          fileSizeBytes: 0,
        };
        res.status(400).json(rejected);
        return;
      }
      if (fetchError instanceof RedirectLimitError) {
        const failed: ParseResponse = {
          success: false,
          error: `Failed to fetch metadata: ${fetchError.message}`,
          parseTimeMs: Date.now() - startTime,
          fileSizeBytes: 0,
        };
        res.status(502).json(failed);
        return;
      }
      throw fetchError;
    }
  } catch (error) {
    // A timeout aborts with a DOMException named "TimeoutError" (not
    // "AbortError"), which is why the friendly message was never reached.
    const status = statusForError(error);
    const response: ParseResponse = {
      success: false,
      error:
        status === 504
          ? 'Request timed out while fetching the metadata document'
          : status >= 500
            ? 'Internal server error'
            : error instanceof Error
              ? error.message
              : 'Unknown error occurred',
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: 0,
    };

    if (status >= 500) console.error('[odata-visualizer] /api/parse/url failed:', error);

    res.status(status).json(response);
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
    const status = statusForError(error);
    const response: ParseResponse = {
      success: false,
      error:
        status >= 500
          ? 'Internal server error'
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred',
      parseTimeMs: Date.now() - startTime,
      fileSizeBytes: 0,
    };

    if (status >= 500) console.error('[odata-visualizer] /api/parse/content failed:', error);

    res.status(status).json(response);
  }
});

export { router as parseRouter };
