import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// In stdio mode stdout carries only MCP protocol messages, so anything else
// written there corrupts the stream for the client.
test('stdio mode writes nothing but protocol messages to stdout', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      ENDPOINT: 'https://127.0.0.1:9/api/v1',
      SUMO_API_ID: 'id',
      SUMO_API_KEY: 'key',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));

  const ready = new Promise<void>((resolve) => {
    child.stdout.on('data', () => resolve());
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }) + '\n',
  );
  await ready;
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  await exited;

  for (const line of stdout.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line), `not JSON-RPC: ${line}`);
  }
});
