import { describe, it, expect } from 'vitest';
import { safeKnowledgeSourceUrl, knowledgeCostLabel } from '../../apps/web/src/lib/knowledge-view';
describe('knowledge source links and cost display', () => {
  it.each([
    'javascript:alert(1)',
    'http://example.invalid/',
    'data:text/html,words',
    'https://user:password@example.invalid/',
    'https:\n//example.invalid/',
    'not a URL',
  ])('omits an unsafe original-source link: %s', (url) => {
    expect(safeKnowledgeSourceUrl(url)).toBeNull();
  });
  it('permits an explicit https source navigation', () => {
    expect(safeKnowledgeSourceUrl('https://example.invalid/document?id=generated')).toBe(
      'https://example.invalid/document?id=generated',
    );
  });
  it('never replaces missing usage with a zero estimate', () => {
    for (const value of [null, NaN, Infinity, -1, 0.5])
      expect(knowledgeCostLabel(value)).toBe('Not available');
    expect(knowledgeCostLabel(0)).toBe('$0.0000 estimated');
    expect(knowledgeCostLabel(1200)).toBe('$0.0012 estimated');
  });
});
