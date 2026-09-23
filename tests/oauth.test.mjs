import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

test('OAuth login and authorization stay on the same Karotter API host', async t => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://karokaro.onrender.com',
      KAROTTER_CLIENT_ID: 'test-client',
      SESSION_SECRET: 'test-session-secret',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  let response;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/auth/start`, { redirect: 'manual' });
      break;
    } catch {
      if (child.exitCode !== null) throw new Error('OAuth test server exited');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.ok(response, 'OAuth test server did not start');
  assert.equal(response.status, 302);
  const login = new URL(response.headers.get('location'));
  assert.equal(login.origin, 'https://api.karotter.com');
  assert.equal(login.pathname, '/login');
  const target = new URL(login.searchParams.get('next'), login.origin);
  assert.equal(target.origin, login.origin);
  assert.equal(target.pathname, '/api/oauth/authorize');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://karokaro.onrender.com/auth/callback');
  assert.equal(target.searchParams.get('scope'), 'profile');
  assert.match(response.headers.get('set-cookie'), /^ks_oauth=/);
});
