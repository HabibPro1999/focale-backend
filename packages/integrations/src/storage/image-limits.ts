/**
 * sharp input options for every decode of an uploaded image.
 * - limitInputPixels: refuse inputs whose header declares more than 20 MP, before
 *   any pixel is decoded (sharp's own default is ~268 MP).
 * - failOn: "warning" aborts on any libvips warning about the pixel data, the
 *   strictest level (none < truncated < error < warning).
 */
export const IMAGE_INPUT_LIMITS = {
  limitInputPixels: 20_000_000,
  failOn: "warning",
} as const;
