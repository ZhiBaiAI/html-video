import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter, {
  playwrightBrowserCacheRoot,
  shouldTrySystemBrowser,
  systemBrowserChannels,
} from '../dist/index.js';

test('exports a render-capable Hyperframes adapter', () => {
  assert.equal(adapter.id, 'hyperframes');
  assert.equal(adapter.name, 'Hyperframes');
  assert.equal(typeof adapter.render, 'function');
  assert.equal(typeof adapter.renderToHtml, 'function');
  assert.ok(adapter.capabilities.outputFormats.includes('mp4'));
  assert.ok(adapter.capabilities.paradigms.includes('html-css-gsap'));
});

test('falls back to installed browser channels only when Playwright cache is missing', () => {
  assert.equal(shouldTrySystemBrowser(new Error("Executable doesn't exist at /cache/chromium")), true);
  assert.equal(shouldTrySystemBrowser(new Error('page crashed')), false);
  assert.deepEqual(systemBrowserChannels('darwin'), ['chrome']);
  assert.deepEqual(systemBrowserChannels('linux'), ['chrome']);
  assert.deepEqual(systemBrowserChannels('win32'), ['chrome', 'msedge']);
  assert.equal(playwrightBrowserCacheRoot('darwin', '/Users/test'), '/Users/test/Library/Caches/ms-playwright');
  assert.equal(playwrightBrowserCacheRoot('linux', '/home/test'), '/home/test/.cache/ms-playwright');
  assert.equal(playwrightBrowserCacheRoot('win32', 'C:\\Users\\test').endsWith('ms-playwright'), true);
});
