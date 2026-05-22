/** Remove script/style blocks, strip HTML tags, decode common entities, collapse whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract plain text from content. Dispatches on file extension. */
export function extractText(content: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'html' || ext === 'htm') return stripHtml(content);
  return content.replace(/\s+/g, ' ').trim();
}

import { PDFParse } from 'pdf-parse';

/** Extract plain text from a PDF buffer using pdf-parse v2. */
export async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text.replace(/\s+/g, ' ').trim();
}
