/** Public module boundary. Consumers receive contract interfaces. */

import {
  createDocumentExtractor as createDocumentExtractorImplementation,
  readPlainText as readPlainTextImplementation,
  runPdftotext as runPdftotextImplementation,
} from '../dsh/document.js';
export const createDocumentExtractor: import('@qqbot/contracts').createDocumentExtractor =
  createDocumentExtractorImplementation;
export const readPlainText: import('@qqbot/contracts').readPlainText = readPlainTextImplementation;
export const runPdftotext: import('@qqbot/contracts').runPdftotext = runPdftotextImplementation;
export { PDF_HELPER_MISSING_REASON } from '../dsh/document.js';
import {
  extensionOf as extensionOfImplementation,
  formatBytes as formatBytesImplementation,
  ingestFiles as ingestFilesImplementation,
} from '../dsh/files.js';
export const extensionOf: import('@qqbot/contracts').extensionOf = extensionOfImplementation;
export const formatBytes: import('@qqbot/contracts').formatBytes = formatBytesImplementation;
export const ingestFiles: import('@qqbot/contracts').ingestFiles = ingestFilesImplementation;
import {
  probeImagePreparer as probeImagePreparerImplementation,
  prepareImageForPrompt as prepareImageForPromptImplementation,
} from '../dsh/image.js';
export const probeImagePreparer: import('@qqbot/contracts').probeImagePreparer =
  probeImagePreparerImplementation;
export const prepareImageForPrompt: import('@qqbot/contracts').prepareImageForPrompt =
  prepareImageForPromptImplementation;
export {
  ADMIT_MAX_DIMENSION,
  ADMIT_MAX_PIXELS,
  MODEL_IMAGE_PIXEL_BUDGET,
  MAX_DECODE_PIXELS,
  SLICE_MIN_ASPECT,
  TILE_TARGET_BYTES,
} from '../dsh/image.js';
import {
  sniffImageMimeType as sniffImageMimeTypeImplementation,
  describeImageRejection as describeImageRejectionImplementation,
  buildImageBlocks as buildImageBlocksImplementation,
  defaultFetchMedia as defaultFetchMediaImplementation,
} from '../dsh/media.js';
export const sniffImageMimeType: import('@qqbot/contracts').sniffImageMimeType =
  sniffImageMimeTypeImplementation;
export const describeImageRejection: import('@qqbot/contracts').describeImageRejection =
  describeImageRejectionImplementation;
export const buildImageBlocks: import('@qqbot/contracts').buildImageBlocks =
  buildImageBlocksImplementation;
export const defaultFetchMedia: import('@qqbot/contracts').defaultFetchMedia =
  defaultFetchMediaImplementation;
export { MAX_BLOCKS_PER_PROMPT } from '../dsh/media.js';
import {
  scanOutbox as scanOutboxImplementation,
  archiveSent as archiveSentImplementation,
} from '../pipeline/egress/outbox.js';
export const scanOutbox: import('@qqbot/contracts').scanOutbox = scanOutboxImplementation;
export const archiveSent: import('@qqbot/contracts').archiveSent = archiveSentImplementation;
export { SENT_DIR_NAME, MTIME_TOLERANCE_MS } from '../pipeline/egress/outbox.js';
import {
  packZip as packZipImplementation,
  packFiles as packFilesImplementation,
} from '../pipeline/egress/zip.js';
export const packZip: import('@qqbot/contracts').packZip = packZipImplementation;
export const packFiles: import('@qqbot/contracts').packFiles = packFilesImplementation;
import {
  sanitizeInboxFileName as sanitizeInboxFileNameImplementation,
  saveInboxFile as saveInboxFileImplementation,
  cleanupInbox as cleanupInboxImplementation,
} from '../store/inbox.js';
export const sanitizeInboxFileName: import('@qqbot/contracts').sanitizeInboxFileName =
  sanitizeInboxFileNameImplementation;
export const saveInboxFile: import('@qqbot/contracts').saveInboxFile = saveInboxFileImplementation;
export const cleanupInbox: import('@qqbot/contracts').cleanupInbox = cleanupInboxImplementation;

import { fetchMediaResult as fetchMediaResultImplementation } from './fetch-result.js';
export const fetchMediaResult: import('@qqbot/contracts').fetchMediaResult =
  fetchMediaResultImplementation;
