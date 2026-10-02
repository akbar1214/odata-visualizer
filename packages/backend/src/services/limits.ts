/**
 * A real `$metadata` document is a few hundred KB at most; the largest models in
 * the test corpus are well under a megabyte. Uploads were previously buffered
 * whole in memory (100 MB), then decoded into a ~2x string, then expanded by
 * fast-xml-parser into an object graph routinely 10-20x the input size.
 *
 * Shared by the upload route and the pinned-file loader so the two caps cannot
 * drift apart.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
