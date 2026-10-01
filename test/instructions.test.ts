import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_INSTRUCTIONS } from '@/instructions.js';

test('server instructions fit the 2048 character limit Claude Code keeps', () => {
  assert.ok(
    SERVER_INSTRUCTIONS.length <= 2048,
    `instructions are ${SERVER_INSTRUCTIONS.length} characters`,
  );
});
