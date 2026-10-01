import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJsonText } from '@/utils/json.js';

test('writes compact JSON with no indentation', () => {
  assert.equal(toJsonText({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
});

test('keeps an object that appears twice without calling it circular', () => {
  const bucket = { count: 0 };
  assert.equal(
    toJsonText({ histogram: [bucket, bucket] }),
    '{"histogram":[{"count":0},{"count":0}]}',
  );
});

test('replaces a real circular reference instead of throwing', () => {
  const node: any = { name: 'a' };
  node.self = node;
  assert.equal(toJsonText(node), '{"name":"a","self":"[Circular Reference]"}');
});
