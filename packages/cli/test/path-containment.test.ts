import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside } from '../dist/studio-server.js';

test('accepts files under a POSIX root and rejects sibling-prefix traversal', () => {
  assert.equal(isPathInside('/repo/templates/card', '/repo/templates/card/index.html', 'linux'), true);
  assert.equal(isPathInside('/repo/templates/card', '/repo/templates/card', 'linux'), true);
  assert.equal(isPathInside('/repo/templates/card', '/repo/templates/card-copy/index.html', 'linux'), false);
  assert.equal(isPathInside('/repo/templates/card', '/repo/templates/card/../secret.txt', 'linux'), false);
});

test('uses Windows path semantics for drive-letter paths', () => {
  assert.equal(isPathInside('C:\\repo\\templates\\card', 'C:\\repo\\templates\\card\\index.html', 'win32'), true);
  assert.equal(isPathInside('C:\\repo\\templates\\card', 'C:\\repo\\templates\\card-copy\\index.html', 'win32'), false);
  assert.equal(isPathInside('C:\\repo\\templates\\card', 'C:\\repo\\templates\\card\\..\\secret.txt', 'win32'), false);
  assert.equal(isPathInside('C:\\repo\\templates\\card', 'D:\\repo\\templates\\card\\index.html', 'win32'), false);
});
