import { describe, expect, it } from 'vitest';

import { getWebVendorScripts, WEB_VENDOR_MARKED_PATH, WEB_VENDOR_PURIFY_PATH } from './local-web/vendor-scripts.js';

describe('web-vendor-scripts', () => {
  it('exposes stable paths for script tags', () => {
    expect(WEB_VENDOR_MARKED_PATH).toMatch(/marked/);
    expect(WEB_VENDOR_PURIFY_PATH).toMatch(/purify/);
  });

  it('loads marked and dompurify from node_modules', () => {
    const { marked, purify } = getWebVendorScripts();
    expect(marked.length).toBeGreaterThan(500);
    expect(purify.length).toBeGreaterThan(500);
    expect(marked).toContain('marked');
    expect(purify).toContain('DOMPurify');
  });
});
