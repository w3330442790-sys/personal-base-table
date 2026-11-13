import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GridTouchGesture } from '../webview/src/grid-touch';

test('touch taps and stationary long presses are mutually exclusive', () => {
    const gesture = new GridTouchGesture();
    gesture.begin(1, 20, 30, 100);
    assert.equal(gesture.hold(649), false);
    assert.equal(gesture.hold(650), true);
    assert.equal(gesture.hold(700), false);
    assert.equal(gesture.end(1), false);
    gesture.begin(2, 20, 30, 800);
    assert.equal(gesture.end(2), true);
});
test('scroll movement, cancellation and second fingers cannot select or open menus', () => {
    const gesture = new GridTouchGesture();
    gesture.begin(1, 0, 0, 0);
    gesture.move(1, 8, 8);
    assert.equal(gesture.hold(550), false);
    assert.equal(gesture.end(1), false);
    gesture.begin(1, 0, 0, 0);
    assert.equal(gesture.begin(2, 0, 0, 20, false), false);
    assert.equal(gesture.end(1), false);
    assert.equal(gesture.end(2), false);
    gesture.begin(1, 0, 0, 0);
    gesture.cancel();
    assert.equal(gesture.hold(550), false);
    assert.equal(gesture.end(1), false);
});
test('ten pixel tolerance and unrelated pointer completion preserve an active tap', () => {
    const gesture = new GridTouchGesture();
    gesture.begin(1, 0, 0, 0);
    gesture.move(1, 10, 0);
    assert.equal(gesture.end(2), false);
    assert.equal(gesture.end(1), true);
});
