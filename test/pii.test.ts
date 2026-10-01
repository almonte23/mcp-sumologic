import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitiveInfo } from '@/utils/pii.js';

// Fake Twilio SIDs, built at runtime so no real-looking SID sits in the
// source for secret scanners (or a real account) to match.
const fakeSid = (prefix: string) => prefix + '0123456789abcdef'.repeat(2);
const CALL_SID = fakeSid('CA');
const CONFERENCE_SID = fakeSid('CF');
const ACCOUNT_SID = fakeSid('AC');

// Shaped like real production portal log lines.
const portalLine = JSON.stringify({
  date: 1790869623.391053,
  host: 'ip-10-0-12-145.ec2.internal',
  timestamp: '2026-10-01T15:47:03.391053Z',
  duration_ms: 16.83125400543213,
  pid: 162,
  payload: {
    params: {
      FriendlyName: 'interpreter-1234567',
      CallSid: CALL_SID,
      ConferenceSid: CONFERENCE_SID,
      AccountSid: ACCOUNT_SID,
      Timestamp: 'Thu, 01 Oct 2026 15:47:03 +0000',
    },
    db_runtime: 22.7,
    allocations: 4270,
    status: 200,
  },
  ecs_task_arn:
    'arn:aws:ecs:us-east-1:123456789012:task/globo-production-us-east-1/00000000000000000000000000000000',
  ip: '203.0.113.10',
  messageid: '-7048887428553688228',
  epoch_ms: 1790869623391,
});

test('leaves timestamps, durations, hosts, ARNs and ids alone', () => {
  const masked = maskSensitiveInfo(portalLine);
  for (const kept of [
    '1790869623.391053',
    'ip-10-0-12-145.ec2.internal',
    '16.83125400543213',
    'interpreter-1234567',
    'Thu, 01 Oct 2026 15:47:03 +0000',
    '123456789012',
    '-7048887428553688228',
    '1790869623391',
    CALL_SID,
    CONFERENCE_SID,
  ]) {
    assert.ok(masked.includes(kept), `kept ${kept}`);
  }
});

test('redacts the client IP in the Rack ip field', () => {
  const masked = maskSensitiveInfo(portalLine);
  assert.ok(!masked.includes('203.0.113.10'));
  assert.ok(masked.includes('"ip":"[IP REDACTED]"'));
});

test('redacts the Twilio account SID', () => {
  const masked = maskSensitiveInfo(portalLine);
  assert.ok(!masked.includes(ACCOUNT_SID));
  assert.ok(masked.includes('[TWILIO ACCOUNT SID REDACTED]'));
});

test('redacts phone numbers', () => {
  for (const phone of [
    '+15551234567',
    '+44 20 7946 0958',
    '(555) 123-4567',
    '555-123-4567',
    '555.123.4567',
    '1-555-123-4567',
  ]) {
    assert.equal(
      maskSensitiveInfo(`From: ${phone} ok`),
      'From: [PHONE REDACTED] ok',
      phone,
    );
  }
  assert.equal(
    maskSensitiveInfo('{"From":"+15551234567"}'),
    '{"From":"[PHONE REDACTED]"}',
  );
});

test('redacts only real looking card numbers', () => {
  assert.equal(
    maskSensitiveInfo('card 4111 1111 1111 1111 ok'),
    'card [CARD NUMBER REDACTED] ok',
  );
  assert.equal(
    maskSensitiveInfo('card 5500-0000-0000-0004'),
    'card [CARD NUMBER REDACTED]',
  );
  assert.equal(maskSensitiveInfo('id 4111111111111112'), 'id 4111111111111112');
});

test('redacts emails, SSNs and addresses', () => {
  assert.equal(
    maskSensitiveInfo('user bob@example.com ssn 123-45-6789'),
    'user [EMAIL REDACTED] ssn [SSN REDACTED]',
  );
  assert.equal(
    maskSensitiveInfo('lives at 123 Main St in town'),
    'lives at [ADDRESS REDACTED] in town',
  );
  assert.equal(
    maskSensitiveInfo('ship to 42 North Oak Avenue, zip 10001-1234'),
    'ship to [ADDRESS REDACTED], zip [ADDRESS REDACTED]',
  );
  assert.equal(maskSensitiveInfo('PO Box 77'), '[ADDRESS REDACTED]');
  assert.equal(
    maskSensitiveInfo('company 11751 count 10001'),
    'company 11751 count 10001',
  );
});

test('redacts values of secret looking keys', () => {
  assert.equal(
    maskSensitiveInfo('{"password":"hunter2","auth_token":"abc","name":"x"}'),
    '{"password":"[SECRET REDACTED]","auth_token":"[SECRET REDACTED]","name":"x"}',
  );
  assert.equal(
    maskSensitiveInfo('{\\"api_key\\":\\"k1\\"}'),
    '{\\"api_key\\":\\"[SECRET REDACTED]\\"}',
  );
  assert.equal(
    maskSensitiveInfo('GET /cb?access_token=xyz&page=2'),
    'GET /cb?access_token=[SECRET REDACTED]&page=2',
  );
});

test('redacts client IPs under client IP keys only', () => {
  assert.equal(
    maskSensitiveInfo(
      '{"tags":["http_remote_address: 207.96.13.12","user_id: 312697"]}',
    ),
    '{"tags":["http_remote_address: [IP REDACTED]","user_id: 312697"]}',
  );
  assert.equal(
    maskSensitiveInfo(
      '{"payload":{"method":"POST","ip":"203.0.113.10"},"remote_ip":"2001:db8::1"}',
    ),
    '{"payload":{"method":"POST","ip":"[IP REDACTED]"},"remote_ip":"[IP REDACTED]"}',
  );
  assert.equal(
    maskSensitiveInfo('{\\"ip\\":\\"10.1.2.3\\"}'),
    '{\\"ip\\":\\"[IP REDACTED]\\"}',
  );
  assert.equal(
    maskSensitiveInfo('X-Forwarded-For: 203.0.113.7, 10.0.0.1 next'),
    'X-Forwarded-For: [IP REDACTED] next',
  );
  const infra =
    '{"host":"ip-172-22-40-126.ec2.internal","_sourcehost":"54.147.73.156","url":"http://10.0.0.5:8080/x"}';
  assert.equal(maskSensitiveInfo(infra), infra, 'infrastructure IPs stay');
});

test('a contiguous + phone does not swallow the next number', () => {
  assert.equal(
    maskSensitiveInfo('From +15551234567 123 attempts'),
    'From [PHONE REDACTED] 123 attempts',
  );
  assert.equal(
    maskSensitiveInfo('to +44 20 7946 0958.'),
    'to [PHONE REDACTED].',
  );
});
