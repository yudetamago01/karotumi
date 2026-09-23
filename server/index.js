import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  databaseReady, createRoom, getRoom, joinRoom, publicState, subscribe,
  startRoom, acceptShape, drop, chooseAfterLoss, leaveRoom, addMessage, persist,
} from './rooms.js';
import { leaderboard, submitScore } from './ranking.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const isProduction = process.env.NODE_ENV === 'production';
const devLogin = !isProduction && process.env.DEV_LOGIN === '1';
const oauthReady = Boolean(process.env.KAROTTER_CLIENT_ID && process.env.PUBLIC_ORIGIN);
const oauthBase = 'https://karotter.com/api/oauth';
const chatTimes = new Map();
const scoreTimes = new Map();
const assetCache = new Map();

function sign(data) {
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}
function verify(token) {
  if (!token) return null;
  const [encoded, mac] = token.split('.');
  if (!encoded || !mac) return null;
  const actual = crypto.createHmac('sha256', sessionSecret).update(encoded).digest();
  const expected = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part.trim(), ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}
function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`;
}
function avatarUrl(value) {
  const candidate = String(value || '').trim().slice(0, 500);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !isProduction)) return null;
    return parsed.toString();
  } catch { return null; }
}
function userFor(req) {
  const session = verify(cookies(req).ks_session);
  return session ? { id: session.id, name: session.name, avatar: avatarUrl(session.avatar) } : null;
}
function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}
function redirect(res, target, headers = {}) {
  res.writeHead(302, { Location: target, 'Cache-Control': 'no-store', ...headers });
  res.end();
}
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 30_000) throw new Error('送信内容が大きすぎます');
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error('JSONが正しくありません'); }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const url = new URL(origin);
  return url.host === req.headers.host || origin === process.env.PUBLIC_ORIGIN;
}
function cleanRoomId(value) { return /^[A-F0-9]{8}$/.test(value || '') ? value : null; }
function fail(res, error, status = 400) { json(res, status, { error: error.message || String(error) }); }

async function serveFile(req, res, pathname) {
  const name = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(root, 'dist', `.${name}`);
  if (!file.startsWith(path.join(root, 'dist') + path.sep) && file !== path.join(root, 'dist', 'index.html')) {
    json(res, 404, { error: 'Not found' }); return;
  }
  try {
    const isAsset = pathname.startsWith('/assets/');
    const accepted = req.headers['accept-encoding'] || '';
    const compressible = isAsset && /\.(?:js|css|svg)$/.test(pathname);
    const encoding = compressible && /\bbr\b/.test(accepted) ? 'br' : compressible && /\bgzip\b/.test(accepted) ? 'gzip' : null;
    const cacheKey = `${file}:${encoding || 'plain'}`;
    let data = assetCache.get(cacheKey);
    if (!data) {
      const source = await fs.readFile(file);
      data = encoding === 'br' ? zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : encoding === 'gzip' ? zlib.gzipSync(source) : source;
      if (isAsset) assetCache.set(cacheKey, data);
    }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache', Vary: 'Accept-Encoding', ...(encoding ? { 'Content-Encoding': encoding } : {}) });
    res.end(data);
  } catch {
    if (pathname.includes('.')) { json(res, 404, { error: 'Not found' }); return; }
    await serveFile(req, res, '/');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;
    if (devLogin && req.headers.origin === process.env.PUBLIC_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', process.env.PUBLIC_ORIGIN);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'POST' && !sameOrigin(req)) { json(res, 403, { error: 'Origin mismatch' }); return; }
    if (pathname === '/api/health') { json(res, 200, { ok: true, database: databaseReady() }); return; }
    if (pathname === '/api/config') { json(res, 200, { oauthReady, devLogin, databaseReady: databaseReady() }); return; }
    if (pathname === '/api/me') { json(res, 200, { user: userFor(req) }); return; }

    if (pathname === '/auth/start' && req.method === 'GET') {
      if (!oauthReady) { fail(res, new Error('Karotter OAuthが未設定です'), 503); return; }
      const state = crypto.randomBytes(24).toString('base64url');
      const roomId = cleanRoomId(url.searchParams.get('room'));
      const next = url.searchParams.get('next') === 'ranking' || url.searchParams.get('ranking') === '1' ? 'ranking' : 'multi';
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const redirectUri = `${process.env.PUBLIC_ORIGIN.replace(/\/$/, '')}/auth/callback`;
      const target = new URL(`${oauthBase}/authorize`);
      target.searchParams.set('response_type', 'code');
      target.searchParams.set('client_id', process.env.KAROTTER_CLIENT_ID);
      target.searchParams.set('redirect_uri', redirectUri);
      target.searchParams.set('scope', 'profile');
      target.searchParams.set('state', state);
      target.searchParams.set('code_challenge', challenge);
      target.searchParams.set('code_challenge_method', 'S256');
      redirect(res, target.toString(), { 'Set-Cookie': cookie('ks_oauth', sign({ state, verifier, roomId, next, exp: Date.now() + 10 * 60_000 }), 600) });
      return;
    }
    if (pathname === '/auth/callback' && req.method === 'GET') {
      const oauth = verify(cookies(req).ks_oauth);
      if (!oauth || oauth.state !== url.searchParams.get('state') || !url.searchParams.get('code')) {
        fail(res, new Error('ログイン認証を確認できませんでした'), 401); return;
      }
      const redirectUri = `${process.env.PUBLIC_ORIGIN.replace(/\/$/, '')}/auth/callback`;
      const params = new URLSearchParams({
        grant_type: 'authorization_code', code: url.searchParams.get('code'),
        redirect_uri: redirectUri, client_id: process.env.KAROTTER_CLIENT_ID,
        code_verifier: oauth.verifier,
      });
      if (process.env.KAROTTER_CLIENT_SECRET) params.set('client_secret', process.env.KAROTTER_CLIENT_SECRET);
      const tokenResponse = await fetch(`${oauthBase}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
      if (!tokenResponse.ok) { fail(res, new Error('Karotterのトークンを取得できませんでした'), 401); return; }
      const token = await tokenResponse.json();
      const profileResponse = await fetch(`${oauthBase}/userinfo`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!profileResponse.ok) { fail(res, new Error('Karotterのユーザー情報を取得できませんでした'), 401); return; }
      const profile = await profileResponse.json();
      const id = String(profile.sub || profile.id || '');
      const name = String(profile.displayName || profile.username || id).slice(0, 40);
      const avatar = avatarUrl(profile.picture || profile.avatar || profile.avatar_url || profile.profileImageUrl || profile.image);
      if (!id) { fail(res, new Error('KarotterのユーザーIDがありません'), 401); return; }
      redirect(res, oauth.next === 'ranking' ? `${process.env.PUBLIC_ORIGIN}/?ranking=1` : `${process.env.PUBLIC_ORIGIN}/?multi=1${oauth.roomId ? `&room=${oauth.roomId}` : ''}`, { 'Set-Cookie': [
        cookie('ks_session', sign({ id, name, avatar, exp: Date.now() + 7 * 86400_000 }), 7 * 86400),
        cookie('ks_oauth', '', 0),
      ] });
      return;
    }
    if (pathname === '/auth/dev' && req.method === 'POST' && devLogin) {
      const input = await bodyJson(req);
      const name = String(input.name || '').trim().slice(0, 24);
      if (!name) { fail(res, new Error('名前を入力してください')); return; }
      const id = `dev-${crypto.randomUUID()}`;
      json(res, 200, { user: { id, name, avatar: null } }, { 'Set-Cookie': cookie('ks_session', sign({ id, name, avatar: null, exp: Date.now() + 86400_000 }), 86400) });
      return;
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      json(res, 200, { ok: true }, { 'Set-Cookie': cookie('ks_session', '', 0) }); return;
    }

    if (pathname === '/api/ranking') {
      if (req.method === 'GET') { json(res, 200, { scores: await leaderboard() }); return; }
      if (req.method !== 'POST') { json(res, 405, { error: 'Method not allowed' }); return; }
      const user = userFor(req);
      if (!user) { json(res, 401, { error: 'Karotterにログインしてください' }); return; }
      if (Date.now() - (scoreTimes.get(user.id) || 0) < 3000) { json(res, 429, { error: '少し待ってから送信してください' }); return; }
      const input = await bodyJson(req);
      const result = await submitScore(user, input.count);
      scoreTimes.set(user.id, Date.now());
      json(res, 200, result); return;
    }

    if (pathname.startsWith('/api/rooms')) {
      const user = userFor(req);
      if (!user) { json(res, 401, { error: 'Karotterにログインしてください' }); return; }
      if (pathname === '/api/rooms' && req.method === 'POST') {
        if (isProduction && !databaseReady()) { json(res, 503, { error: '外部DBが未設定です' }); return; }
        const input = await bodyJson(req);
        const password = String(input.password || '');
        if (password.length > 72) throw new Error('パスワードは72文字以内にしてください');
        const room = await createRoom(user, password);
        json(res, 201, { room: publicState(room, user.id) }); return;
      }
      const match = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|start|shape|drop|chat|choice|leave|events))?$/);
      const id = cleanRoomId(match?.[1]);
      if (!id) { json(res, 404, { error: 'ルームが見つかりません' }); return; }
      const room = await getRoom(id);
      if (!room) { json(res, 404, { error: 'ルームが見つかりません' }); return; }
      const action = match?.[2] || '';
      if (action === 'join' && req.method === 'POST') {
        const input = await bodyJson(req);
        joinRoom(room, user, String(input.password || ''));
        await persist(room);
        json(res, 200, { room: publicState(room, user.id) }); return;
      }
      const member = room.members.get(user.id);
      if (!member || member.status === 'left') { json(res, 403, { error: 'ルームに参加してください' }); return; }
      if (!action && req.method === 'GET') { json(res, 200, { room: publicState(room, user.id) }); return; }
      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        subscribe(room, res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        res.on('close', () => clearInterval(ping));
        return;
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'Method not allowed' }); return; }
      const input = await bodyJson(req);
      if (action === 'start') startRoom(room, user);
      else if (action === 'shape') {
        if (!acceptShape(room, input)) throw new Error('文字の形を登録できませんでした');
      } else if (action === 'drop') drop(room, user.id, input.x, input.shape);
      else if (action === 'choice') chooseAfterLoss(room, user.id, input.choice);
      else if (action === 'leave') leaveRoom(room, user.id);
      else if (action === 'chat') {
        const text = String(input.body || '').trim();
        if (!text || text.length > 200) throw new Error('チャットは1〜200文字です');
        const last = chatTimes.get(user.id) || 0;
        if (Date.now() - last < 750) throw new Error('少し待ってから送信してください');
        chatTimes.set(user.id, Date.now());
        const message = await addMessage(room, user, text);
        // Chat is batched by the room's dirty-state timer to keep DB egress low.
        json(res, 200, { message }); return;
      } else { json(res, 404, { error: 'Not found' }); return; }
      if (action !== 'shape') persist(room).catch(error => console.error('Save room:', error.message));
      json(res, 200, action === 'shape' ? { ok: true } : { room: publicState(room, user.id) }); return;
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) { json(res, 404, { error: 'Not found' }); return; }
    await serveFile(req, res, pathname);
  } catch (error) {
    console.error('Request:', error);
    fail(res, error, error.message?.startsWith('Database request failed') || error.message === '外部DBが未設定です' ? 503 : 400);
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Karotter stack server on :${port}`));
