import { describe, expect, it } from 'vitest';

import { encodeGmailRaw } from './gmail-send.js';

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf-8');
}

describe('encodeGmailRaw', () => {
  it('builds a minimal RFC 2822 message with default From', () => {
    const raw = encodeGmailRaw({
      to: 'student@school.edu',
      subject: 'Your sign-in code',
      body: 'Your code: 123456',
    });
    const decoded = decode(raw);
    expect(decoded).toContain('To: student@school.edu');
    expect(decoded).toContain('Subject: Your sign-in code');
    expect(decoded).toContain('MIME-Version: 1.0');
    expect(decoded).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decoded).toContain('\r\n\r\nYour code: 123456');
    expect(decoded).not.toContain('From:');
  });

  it('includes optional From and Reply-To headers when provided', () => {
    const raw = encodeGmailRaw({
      from: 'Prof Smith <prof@school.edu>',
      replyTo: 'noreply@school.edu',
      to: 'a@b.c',
      subject: 'Hi',
      body: 'hi',
    });
    const decoded = decode(raw);
    expect(decoded).toContain('From: Prof Smith <prof@school.edu>');
    expect(decoded).toContain('Reply-To: noreply@school.edu');
  });

  it('uses CRLF line endings (Gmail requires RFC 2822-compliant separators)', () => {
    const raw = encodeGmailRaw({ to: 'a@b.c', subject: 'X', body: 'Y' });
    expect(decode(raw)).toMatch(/To: a@b\.c\r\n/);
    expect(decode(raw)).toMatch(/\r\n\r\nY$/);
  });

  it('encodes non-ASCII subjects as RFC 2047 encoded-words', () => {
    const raw = encodeGmailRaw({ to: 'a@b.c', subject: 'résumé 📧', body: 'body' });
    const decoded = decode(raw);
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/);
    // Pulled the b64 chunk back out and decoded — should round-trip to the original.
    const match = decoded.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/);
    expect(match).toBeTruthy();
    expect(Buffer.from(match![1]!, 'base64').toString('utf-8')).toBe('résumé 📧');
  });

  it('passes ASCII subjects through unchanged', () => {
    const raw = encodeGmailRaw({ to: 'a@b.c', subject: 'Hello there', body: 'body' });
    expect(decode(raw)).toContain('Subject: Hello there');
  });

  it('preserves multi-line bodies', () => {
    const raw = encodeGmailRaw({
      to: 'a@b.c',
      subject: 'X',
      body: 'line one\nline two\n\nline three',
    });
    expect(decode(raw)).toContain('line one\nline two\n\nline three');
  });
});
