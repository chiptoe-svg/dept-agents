/**
 * Typical work-file allowlist for member chat attachments. Default-deny:
 * only these extensions are accepted (executables/binaries are rejected by
 * omission). The server is the real gate; the frontend `accept=` is a hint.
 */
export const ATTACHMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  // docs
  'pdf',
  'doc',
  'docx',
  'txt',
  'rtf',
  'md',
  'odt',
  // spreadsheets
  'csv',
  'tsv',
  'xls',
  'xlsx',
  'ods',
  // slides
  'ppt',
  'pptx',
  'odp',
  'key',
  // images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'heic',
  'bmp',
  'tiff',
  // data / text
  'json',
  'xml',
  'yaml',
  'yml',
]);

export function isAllowedAttachment(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return ATTACHMENT_ALLOWLIST.has(ext);
}
