import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import multer from 'multer';
import { parseCSDL } from '../services/xmlParser.js';
import { metadataStore } from '../services/metadataStore.js';
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
    const data = await parseCSDL(xmlContent);

    metadataStore.set(data, {
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

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      const response: ParseResponse = {
        success: false,
        error: 'Invalid URL format',
        parseTimeMs: Date.now() - startTime,
        fileSizeBytes: 0,
      };
      res.status(400).json(response);
      return;
    }

    // Fetch metadata from URL
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await fetch(parsedUrl.toString(), {
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

      const xmlContent = await response.text();
      const contentLength = response.headers.get('content-length');
      const fileSizeBytes = contentLength ? parseInt(contentLength, 10) : xmlContent.length;

      const data = await parseCSDL(xmlContent);

      metadataStore.set(data, {
        sourceName: parsedUrl.toString(),
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
    const { content } = req.body as { content?: string };

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

    const data = await parseCSDL(content);

    metadataStore.set(data, {
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
