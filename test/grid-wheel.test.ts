import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wheelScroll } from '../webview/src/grid-wheel';

const verticalOnly = { clientWidth: 800, clientHeight: 400, scrollWidth: 800, scrollHeight: 2000 };
const horizontalOnly = { clientWidth: 800, clientHeight: 400, scrollWidth: 2000, scrollHeight: 400 };
const both = { clientWidth: 800, clientHeight: 400, scrollWidth: 2000, scrollHeight: 2000 };
const plain = { deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false };

test('plain wheel scrolls vertically like Excel and shifts scrolls sideways', () => {
    assert.deepEqual(wheelScroll(plain, verticalOnly), { dx: 0, dy: 120 });
    assert.deepEqual(wheelScroll({ ...plain, shiftKey: true }, both), { dx: 120, dy: 0 });
    assert.equal(wheelScroll({ ...plain, shiftKey: true }, verticalOnly), null);
});

test('horizontal wheel and horizontal-only tables scroll sideways', () => {
    assert.deepEqual(wheelScroll({ ...plain, deltaX: 60, deltaY: 10 }, both), { dx: 60, dy: 0 });
    assert.deepEqual(wheelScroll(plain, horizontalOnly), { dx: 120, dy: 0 });
    assert.deepEqual(wheelScroll({ ...plain, deltaY: -120 }, horizontalOnly), { dx: -120, dy: 0 });
});

test('ctrl/cmd wheel is left to the host for zooming and idle tables bubble', () => {
    assert.equal(wheelScroll({ ...plain, ctrlKey: true }, both), null);
    assert.equal(wheelScroll({ ...plain, metaKey: true }, both), null);
    assert.equal(wheelScroll(plain, { ...both, scrollWidth: 800, scrollHeight: 400 }), null);
});

test('line and page deltas are normalized', () => {
    assert.deepEqual(wheelScroll({ ...plain, deltaY: 3, deltaMode: 1 }, verticalOnly), { dx: 0, dy: 48 });
    const page = wheelScroll({ ...plain, deltaY: 1, deltaMode: 2 }, verticalOnly);
    assert.deepEqual(page, { dx: 0, dy: 800 });
});
