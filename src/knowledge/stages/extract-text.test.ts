import { describe, it, expect } from 'vitest';
import { stripHtml, extractText } from './extract-text.js';

describe('stripHtml', () => {
  it('removes script blocks', () => {
    expect(stripHtml('<script>alert(1)</script>hello')).toBe('hello');
  });
  it('removes style blocks', () => {
    expect(stripHtml('<style>body{}</style>world')).toBe('world');
  });
  it('strips tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });
  it('decodes common entities', () => {
    expect(stripHtml('Tom &amp; Jerry &lt;3&gt;')).toBe('Tom & Jerry <3>');
  });
  it('collapses whitespace', () => {
    expect(stripHtml('  a   b  ')).toBe('a b');
  });
});

describe('extractText', () => {
  it('routes .html through stripHtml', () => {
    const out = extractText('<p>hi</p>', 'page.html');
    expect(out).toBe('hi');
  });
  it('routes .htm through stripHtml', () => {
    const out = extractText('<b>ok</b>', 'page.htm');
    expect(out).toBe('ok');
  });
  it('normalizes plain text whitespace', () => {
    const out = extractText('  hello   world  \n\n  ', 'note.txt');
    expect(out).toBe('hello world');
  });
});
