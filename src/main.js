import Matter from 'matter-js';
import { createTermPicker } from './termPicker.js';
import { splitTerm, makeTextSprite, makeTextBody } from './textBodies.js';
import { openMultiplayer } from './multi.js';
import { bindHoldRotation, rotationIcon } from './rotationControls.js';
import { stageGeometry, TEXT_STAGE_WIDTH } from './stageGeometry.js';
import './style.css';

const { Engine, Bodies, Body, Composite, Events } = Matter;
const app = document.querySelector('#app');
const inks = ['#087bb6', '#1466ad', '#0a91b9', '#456fbd', '#137e9e'];
const API_ORIGIN = import.meta.env.DEV ? 'http://127.0.0.1:3001' : '';

const saved = (() => {
  try { return JSON.parse(localStorage.getItem('karotter-stack-settings') || '{}'); }
  catch { return {}; }
})();
const settings = { music: saved.music ?? true, sound: saved.sound ?? true, volume: saved.volume ?? 55 };
let best = Number(localStorage.getItem('karotter-stack-best') || 0);
let screen = 'home';
let game = null;
let frame = 0;
let lastFrame = 0;
let audioContext;
let musicTimer;
let musicStep = 0;
let multiplayer = null;
let scoreSync = null;
let scoreRetryTimer = null;

function saveSettings() { localStorage.setItem('karotter-stack-settings', JSON.stringify(settings)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
async function rankingApi(path, body) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `通信エラー (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function retryScoreSync() {
  if (scoreRetryTimer) return;
  scoreRetryTimer = window.setTimeout(() => {
    scoreRetryTimer = null;
    void syncPendingScore();
  }, 3200);
}
function rememberScore(count) {
  if (!Number.isSafeInteger(count) || count < 1) return;
  const pending = Number(localStorage.getItem('karotter-stack-ranking-pending') || 0);
  if (count > pending) localStorage.setItem('karotter-stack-ranking-pending', String(count));
  void syncPendingScore();
}
function syncPendingScore() {
  if (scoreSync) return scoreSync;
  const count = Number(localStorage.getItem('karotter-stack-ranking-pending') || 0);
  if (!Number.isSafeInteger(count) || count < 1) return Promise.resolve(null);
  scoreSync = rankingApi('/api/ranking', { count }).then(result => {
    const latest = Number(localStorage.getItem('karotter-stack-ranking-pending') || 0);
    if (latest <= count) {
      localStorage.removeItem('karotter-stack-ranking-pending');
    } else retryScoreSync();
    return result;
  }).catch(error => {
    if (error.status === 429) retryScoreSync();
    return null;
  }).finally(() => { scoreSync = null; });
  return scoreSync;
}

function tone(freq, duration, type = 'sine', gain = .08, delay = 0) {
  if (type === 'triangle' ? !settings.music : !settings.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    const now = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const volume = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, now);
    volume.gain.setValueAtTime(.0001, now);
    volume.gain.exponentialRampToValueAtTime(gain * settings.volume / 100, now + .012);
    volume.gain.exponentialRampToValueAtTime(.0001, now + duration);
    oscillator.connect(volume).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + .02);
  } catch { /* Sound remains optional when the browser blocks audio. */ }
}
function sfx(name) {
  if (name === 'tap') { tone(530, .12, 'sine', .13); tone(780, .12, 'sine', .08, .05); }
  if (name === 'back') { tone(740, .11, 'sine', .11); tone(520, .19, 'sine', .12, .07); }
  if (name === 'exit') { tone(490, .13, 'sine', .11); tone(370, .16, 'sine', .12, .09); tone(247, .23, 'sine', .12, .19); }
  if (name === 'drop') tone(320, .13, 'sine', .10);
  if (name === 'land') { tone(250, .14, 'sine', .16); tone(390, .18, 'sine', .10, .055); }
  if (name === 'score') { tone(523, .13, 'sine', .12); tone(659, .14, 'sine', .12, .10); tone(784, .18, 'sine', .11, .20); }
  if (name === 'over') { tone(392, .18, 'sine', .12); tone(311, .25, 'sine', .13, .13); tone(196, .40, 'sine', .15, .30); }
}
function stopMusic() { if (musicTimer) clearInterval(musicTimer); musicTimer = null; }
function startMusic() {
  if (!settings.music || musicTimer) return;
  const melody = [
    523, 0, 659, 784, 659, 0, 587, 523,
    440, 0, 523, 659, 587, 0, 392, 0,
    440, 523, 587, 0, 659, 784, 880, 0,
    784, 659, 587, 523, 0, 587, 659, 0,
    698, 0, 880, 784, 698, 659, 587, 0,
    523, 587, 659, 0, 523, 440, 392, 0,
    523, 659, 784, 0, 880, 784, 659, 587,
    523, 0, 440, 523, 587, 0, 523, 0,
  ];
  const bass = [262, 220, 196, 220, 220, 262, 294, 196, 349, 294, 262, 220, 262, 196, 220, 262];
  musicTimer = window.setInterval(() => {
    if (document.hidden || !['game', 'home', 'multi', 'settings', 'ranking', 'loading'].includes(screen) || game?.paused || game?.over) return;
    const note = melody[musicStep % melody.length];
    if (note) tone(note, .20, 'triangle', .058);
    if (musicStep % 4 === 0) tone(bass[Math.floor(musicStep / 4) % bass.length], .31, 'triangle', .042);
    musicStep++;
  }, 245);
}

function shell(content, className) {
  app.innerHTML = `<main class="app-shell ${className}">${content}</main>`;
  window.scrollTo(0, 0);
}
function home() {
  stopGame();
  multiplayer?.destroy();
  multiplayer = null;
  screen = 'home';
  shell(`<section class="home-center">
    <h1>Karotter用語積み</h1>
    <div class="home-buttons">
      <button class="button primary" id="start-btn">ひとりで積む</button>
      <button class="button secondary" id="multi-btn">みんなで積む</button>
      <button class="button secondary" id="ranking-btn">ランキング</button>
      <button class="button secondary" id="settings-btn">設定</button>
    </div>
  </section>`, 'home-screen');
  document.querySelector('#start-btn').addEventListener('click', () => { sfx('tap'); startGame(); });
  document.querySelector('#multi-btn').addEventListener('click', () => { sfx('tap'); showMultiplayer(); });
  document.querySelector('#ranking-btn').addEventListener('click', () => { sfx('tap'); showRanking(); });
  document.querySelector('#settings-btn').addEventListener('click', () => { sfx('tap'); showSettings(); });
  startMusic();
}
async function showRanking() {
  stopGame();
  multiplayer?.destroy();
  multiplayer = null;
  screen = 'ranking';
  startMusic();
  shell(`<section class="ranking-panel">
    <button class="icon-button ranking-back" id="ranking-back" aria-label="ホームへ戻る">←</button>
    <h1>個数ランキング</h1>
    <p class="ranking-caption">ひとりで積んだ最高個数</p>
    <div id="ranking-login" class="ranking-login"></div>
    <p id="ranking-notice" class="ranking-notice" role="status">読み込み中…</p>
    <ol id="ranking-list" class="ranking-list"></ol>
  </section>`, 'ranking-screen');
  document.querySelector('#ranking-back').addEventListener('click', () => { sfx('back'); home(); });
  const notice = document.querySelector('#ranking-notice');
  const login = document.querySelector('#ranking-login');
  const renderLogin = (user, config) => {
    if (user) {
      login.innerHTML = `<p class="ranking-user">ログイン中：${escapeHtml(user.name)}</p>`;
      return;
    }
    const oauth = config?.oauthReady ? `<a class="button primary" href="${API_ORIGIN}/auth/start?next=ranking">Karotterでログイン</a>` : '';
    const devForm = config?.devLogin ? '<form id="ranking-dev-login"><label>ローカルテスト名<input name="name" maxlength="24" required placeholder="名前"></label><button class="button secondary" type="submit">テストログイン</button></form>' : '';
    login.innerHTML = `<div class="ranking-login-actions">${oauth}${devForm}</div>${!oauth && !devForm ? '<p>ランキングへの記録にはログインが必要です。</p>' : ''}`;
    document.querySelector('#ranking-dev-login')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await rankingApi('/auth/dev', { name: new FormData(event.currentTarget).get('name') });
        await showRanking();
      } catch (error) { notice.textContent = error.message; }
    });
  };
  try {
    const [data, me, config] = await Promise.all([
      rankingApi('/api/ranking'), rankingApi('/api/me').catch(() => ({})), rankingApi('/api/config').catch(() => ({})),
    ]);
    if (screen !== 'ranking') return;
    renderLogin(data.user || me.user, config);
    const synced = data.user || me.user ? await syncPendingScore() : null;
    if (screen !== 'ranking') return;
    const scoreData = synced?.updated ? await rankingApi('/api/ranking') : data;
    if (screen !== 'ranking') return;
    const scores = Array.isArray(scoreData.scores) ? scoreData.scores.slice(0, 20) : [];
    document.querySelector('#ranking-list').innerHTML = scores.length
      ? scores.map((score, index) => `<li><span class="ranking-place">${index + 1}</span>${score.avatar ? `<img src="${escapeHtml(score.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="ranking-name">${escapeHtml(score.name)}</span><strong>${Number(score.bestCount) || 0}<small>こ</small></strong></li>`).join('')
      : '<li class="ranking-empty">まだ記録がありません</li>';
    notice.textContent = '';
  } catch (error) {
    if (screen === 'ranking') notice.textContent = `${error.message}。サーバーに接続できません。`;
  }
}
async function showMultiplayer() {
  stopGame();
  screen = 'multi';
  startMusic();
  const instance = await openMultiplayer(app, () => {
    sfx('back');
    history.replaceState(null, '', '/');
    home();
  }, sfx);
  if (screen !== 'multi') { instance.destroy(); return; }
  multiplayer = instance;
}
function showSettings() {
  screen = 'settings';
  startMusic();
  shell(`<section class="settings-panel">
    <button class="icon-button settings-back" id="back-btn" aria-label="戻る">←</button>
    <h1>設定</h1>
    <div class="setting-row"><span>音楽</span><button class="toggle ${settings.music ? 'on' : ''}" id="music-toggle" role="switch" aria-checked="${settings.music}" aria-label="音楽"><span></span></button></div>
    <div class="setting-row"><span>効果音</span><button class="toggle ${settings.sound ? 'on' : ''}" id="sound-toggle" role="switch" aria-checked="${settings.sound}" aria-label="効果音"><span></span></button></div>
    <div class="setting-row"><span>音量</span><div class="volume-control"><input id="volume-range" type="range" min="0" max="100" value="${settings.volume}" aria-label="音量"><output id="volume-value">${settings.volume}%</output></div></div>
    <a class="reference" href="https://karotter-wiki.vercel.app/index/index.html" target="_blank" rel="noopener noreferrer">参考サイト：カロッター用語辞典 ↗</a>
  </section>`, 'settings-screen');
  document.querySelector('#back-btn').addEventListener('click', () => { sfx('back'); home(); });
  document.querySelector('#music-toggle').addEventListener('click', e => {
    settings.music = !settings.music;
    e.currentTarget.classList.toggle('on', settings.music);
    e.currentTarget.setAttribute('aria-checked', String(settings.music));
    saveSettings();
    if (settings.music) { sfx('tap'); startMusic(); } else stopMusic();
  });
  document.querySelector('#sound-toggle').addEventListener('click', e => {
    settings.sound = !settings.sound;
    e.currentTarget.classList.toggle('on', settings.sound);
    e.currentTarget.setAttribute('aria-checked', String(settings.sound));
    saveSettings();
    sfx('tap');
  });
  document.querySelector('#volume-range').addEventListener('input', e => {
    settings.volume = Number(e.target.value);
    document.querySelector('#volume-value').textContent = `${settings.volume}%`;
    saveSettings();
  });
}

function stopGame() {
  cancelAnimationFrame(frame);
  game?.rotationCleanup?.();
  if (game?.resizeObserver) game.resizeObserver.disconnect();
  game = null;
}
function dequeuePiece() {
  if (!game.queue.length) game.queue.push(...splitTerm(game.pickTerm()));
  return game.queue.shift();
}
async function startGame() {
  stopGame();
  screen = 'loading';
  await document.fonts.ready;
  if (screen !== 'loading') return;
  screen = 'game';
  shell(`<canvas id="stage" aria-label="用語を積み上げるゲーム画面"></canvas>
    <header class="game-hud">
      <div class="stats">
        <div class="stat"><span>つんだ数</span><strong id="score">0</strong></div>
        <div class="stat"><span>次の用語</span><strong id="next-word"></strong></div>
        <div class="stat"><span>ベスト</span><strong id="best-score">${best}</strong></div>
      </div>
      <button class="icon-button" id="pause-btn" aria-label="一時停止">Ⅱ</button>
    </header>
    <div class="rotation-controls" aria-label="用語の回転">
      <button class="rotate-button" id="rotate-left" type="button" aria-label="用語を左に15度回転" title="左に回転（Q）">${rotationIcon(-1)}<span class="rotate-step">15°</span></button>
      <button class="rotate-button" id="rotate-right" type="button" aria-label="用語を右に15度回転" title="右に回転（E）"><span class="rotate-step">15°</span>${rotationIcon(1)}</button>
    </div>
    <div id="overlay-root"></div>`, 'game-screen');
  const canvas = document.querySelector('#stage');
  const engine = Engine.create({ gravity: { x: 0, y: 1.15 }, enableSleeping: true });
  engine.positionIterations = 10;
  engine.velocityIterations = 10;
  engine.constraintIterations = 4;
  game = {
    canvas, ctx: canvas.getContext('2d'), engine, blocks: [], active: null,
    queue: [], pickTerm: createTermPicker(), pending: null, next: null, score: 0, paused: false, over: false,
    dragPointerId: null, pendingAngle: 0,
    viewScale: 1, displayScale: 1, targetX: 0, width: 0, height: 0, spawnY: 185, spawnTop: 185, topPadding: 110,
    base: null, baseWidth: 0, particles: [], resizeObserver: null, accumulator: 0,
    landing: false, landingTicks: 0, stableTicks: 0,
  };
  game.pending = dequeuePiece();
  game.next = dequeuePiece();
  document.querySelector('#next-word').textContent = game.next.text;
  sizeStage();
  game.resizeObserver = new ResizeObserver(sizeStage);
  game.resizeObserver.observe(canvas);
  Events.on(engine, 'collisionStart', event => {
    if (!game || game.over || !game.active) return;
    for (const pair of event.pairs) {
      const a = pair.bodyA.parent;
      const b = pair.bodyB.parent;
      const other = a === game.active ? b : b === game.active ? a : null;
      if (other && (other === game.base || game.blocks.includes(other)) && game.active.position.y < other.position.y + 20) {
        game.landing = true;
        break;
      }
    }
  });
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  document.querySelector('#pause-btn').addEventListener('click', togglePause);
  game.rotationCleanup = bindHoldRotation(
    document.querySelector('#rotate-left'), document.querySelector('#rotate-right'), rotatePending,
  );
  window.addEventListener('keydown', onKeyDown);
  startMusic();
  lastFrame = performance.now();
  frame = requestAnimationFrame(loop);
}
function sizeStage() {
  if (!game) return;
  const { canvas, ctx, engine } = game;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const oldWidth = game.width;
  const oldBaseY = game.base?.position.y;
  const geometry = stageGeometry(rect.width, rect.height);
  game.displayScale = geometry.displayScale;
  game.width = geometry.width;
  game.height = geometry.height;
  game.spawnTop = geometry.spawnTop;
  game.topPadding = geometry.topPadding;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const baseWidth = geometry.baseWidth;
  if (!game.base) {
    game.baseWidth = baseWidth;
    game.base = Bodies.rectangle(game.width / 2, geometry.baseY, baseWidth, 28, { isStatic: true, label: 'base', friction: 1.1 });
    Composite.add(engine.world, game.base);
    game.targetX = game.width / 2;
  } else {
    const shift = (game.width - oldWidth) / 2;
    const rise = geometry.baseY - oldBaseY;
    if (game.baseWidth !== baseWidth) Body.scale(game.base, baseWidth / game.baseWidth, 1);
    game.baseWidth = baseWidth;
    Body.setPosition(game.base, { x: game.width / 2, y: geometry.baseY });
    if (Math.abs(shift) > 1 || Math.abs(rise) > 1) {
      for (const block of game.blocks) Body.setPosition(block, { x: block.position.x + shift, y: block.position.y + rise });
      for (const particle of game.particles) { particle.x += shift; particle.y += rise; }
      game.targetX = Math.max(20, Math.min(game.width - 20, game.targetX + shift));
    }
  }
  const highest = game.blocks.reduce((y, block) => Math.min(y, block.bounds.min.y), game.base.position.y);
  game.spawnY = Math.min(game.spawnTop, game.base.position.y - 100, ...(game.blocks.length ? [highest - 155] : []));
}
function onPointerMove(event) {
  if (!game || game.paused || game.over) return;
  if (event.pointerType !== 'mouse' && game.dragPointerId !== event.pointerId) return;
  const rect = game.canvas.getBoundingClientRect();
  const scale = game.viewScale;
  const offsetX = game.width * (1 - scale) / 2;
  const worldX = (event.clientX - rect.left) / game.displayScale;
  game.targetX = Math.max(20, Math.min(game.width - 20, (worldX - offsetX) / scale));
}
function onPointerDown(event) {
  if (!game || game.active || game.paused || game.over) return;
  event.preventDefault();
  if (event.pointerType !== 'mouse') {
    if (game.dragPointerId !== null) return;
    game.dragPointerId = event.pointerId;
    game.canvas.setPointerCapture(event.pointerId);
  }
  onPointerMove(event);
  if (event.pointerType === 'mouse') drop();
}
function onPointerUp(event) {
  if (!game || game.dragPointerId !== event.pointerId) return;
  onPointerMove(event);
  game.dragPointerId = null;
  if (game.canvas.hasPointerCapture(event.pointerId)) game.canvas.releasePointerCapture(event.pointerId);
  drop();
}
function onPointerCancel(event) {
  if (game?.dragPointerId === event.pointerId) game.dragPointerId = null;
}
function onKeyDown(event) {
  if (screen !== 'game' || !game) return;
  if (['ArrowLeft', 'ArrowRight', 'Space', 'Escape', 'KeyQ', 'KeyE'].includes(event.code)) event.preventDefault();
  if (event.code === 'Escape') { togglePause(); return; }
  if (game.paused || game.over) return;
  if (event.repeat && (event.code === 'KeyQ' || event.code === 'KeyE')) return;
  if (event.code === 'ArrowLeft') game.targetX = Math.max(20, game.targetX - 24);
  if (event.code === 'ArrowRight') game.targetX = Math.min(game.width - 20, game.targetX + 24);
  if (event.code === 'KeyQ') rotatePending(-1);
  if (event.code === 'KeyE') rotatePending(1);
  if (event.code === 'Space') drop();
}
function rotatePending(direction) {
  if (!game || game.active || game.paused || game.over) return;
  game.pendingAngle += direction * Math.PI / 12;
  if (game.pendingAngle > Math.PI) game.pendingAngle -= Math.PI * 2;
  if (game.pendingAngle < -Math.PI) game.pendingAngle += Math.PI * 2;
  sfx('tap');
}
function setRotateEnabled(enabled) {
  for (const button of document.querySelectorAll('.game-screen .rotate-button')) button.disabled = !enabled;
}
function pendingHalfExtents(sprite) {
  const cosine = Math.abs(Math.cos(game.pendingAngle));
  const sine = Math.abs(Math.sin(game.pendingAngle));
  return {
    x: (sprite.width * cosine + sprite.height * sine) / 2,
    y: (sprite.height * cosine + sprite.width * sine) / 2,
  };
}
function pendingX(sprite) {
  const halfWidth = pendingHalfExtents(sprite).x;
  return Math.max(halfWidth + 6, Math.min(game.width - halfWidth - 6, game.targetX));
}
function spawnPosition() {
  return game.spawnY;
}
function pendingSprite() {
  return makeTextSprite(game.pending, TEXT_STAGE_WIDTH, inks[game.blocks.length % inks.length]);
}
function drop() {
  if (!game || game.active || game.paused || game.over) return;
  const sprite = pendingSprite();
  const x = pendingX(sprite);
  const body = makeTextBody(sprite, x, spawnPosition());
  Body.setAngle(body, game.pendingAngle);
  Composite.add(game.engine.world, body);
  game.blocks.push(body);
  game.active = body;
  setRotateEnabled(false);
  game.landing = false;
  game.landingTicks = 0;
  game.stableTicks = 0;
  game.pendingAngle = 0;
  sfx('drop');
}
function settlePiece() {
  if (!game?.active || game.over || !game.landing) return;
  const body = game.active;
  game.landingTicks++;
  if (body.speed < .65 && body.angularSpeed < .025) game.stableTicks++;
  else game.stableTicks = 0;
  if (game.landingTicks < 30 || (game.stableTicks < 16 && game.landingTicks < 170)) return;
  // Matter handles sleep after contact resolution; forcing it here makes
  // following letters shove the lower pile sideways.
  game.landing = false;
  game.score++;
  document.querySelector('#score').textContent = game.score;
  if (game.score > best) {
    best = game.score;
    localStorage.setItem('karotter-stack-best', String(best));
    document.querySelector('#best-score').textContent = best;
  }
  sfx('land');
  sfx('score');
  burst(body.position.x, body.bounds.min.y, 12);
  game.active = null;
  setRotateEnabled(true);
  const highest = game.blocks.reduce((y, block) => Math.min(y, block.bounds.min.y), game.base.position.y);
  game.spawnY = Math.min(game.spawnTop, highest - 155);
  game.pending = game.next;
  game.next = dequeuePiece();
  document.querySelector('#next-word').textContent = game.next.text;
}
function checkLoss() {
  if (!game || game.over) return;
  const leftLimit = game.base.bounds.min.x - 120;
  const rightLimit = game.base.bounds.max.x + 120;
  for (const body of game.blocks) {
    if (body.position.y > game.base.position.y + 95 || body.bounds.max.x < leftLimit || body.bounds.min.x > rightLimit) {
      gameOver();
      break;
    }
  }
}
function gameOver() {
  if (!game || game.over) return;
  game.over = true;
  setRotateEnabled(false);
  sfx('over');
  stopMusic();
  rememberScore(game.score);
  document.querySelector('#overlay-root').innerHTML = `<div class="overlay"><section class="modal">
    <h2>ゲームオーバー</h2><p class="result">${game.score}<span>こ</span></p>
    <p class="modal-best">ベスト ${best}</p>
    <button class="button primary" id="again-btn">もういちど</button>
    <button class="button secondary" id="end-home-btn">ホームへ</button>
  </section></div>`;
  document.querySelector('#again-btn').addEventListener('click', () => { sfx('tap'); startGame(); });
  document.querySelector('#end-home-btn').addEventListener('click', () => { sfx('back'); home(); });
}
function togglePause() {
  if (!game || game.over) return;
  game.paused = !game.paused;
  sfx('tap');
  const root = document.querySelector('#overlay-root');
  if (!game.paused) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="overlay"><section class="modal">
    <h2>一時停止</h2>
    <button class="button primary" id="resume-btn">つづける</button>
    <button class="button secondary" id="restart-btn">はじめから</button>
    <button class="button secondary" id="pause-home-btn">ホームへ</button>
  </section></div>`;
  document.querySelector('#resume-btn').addEventListener('click', togglePause);
  document.querySelector('#restart-btn').addEventListener('click', () => { sfx('tap'); startGame(); });
  document.querySelector('#pause-home-btn').addEventListener('click', () => { sfx('back'); home(); });
}
function burst(x, y, count) {
  if (!game) return;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.3 + Math.random() * 2.5;
    game.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1, life: 30 + Math.random() * 15 });
  }
}
function drawSprite(ctx, sprite, x, y, angle = 0, alpha = 1, offsetX = 0, offsetY = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;
  ctx.shadowColor = '#2077aa55';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 5;
  ctx.drawImage(sprite.canvas, offsetX - sprite.width / 2, offsetY - sprite.height / 2);
  ctx.restore();
}
function draw() {
  if (!game) return;
  const { ctx, width: W, height: H, base } = game;
  ctx.save();
  ctx.scale(game.displayScale, game.displayScale);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#dff6ff';
  ctx.fillRect(0, 0, W, H);
  const scale = game.viewScale;
  const baseY = base.position.y;
  ctx.save();
  ctx.translate(W * (1 - scale) / 2, baseY * (1 - scale));
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#176eaa';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(W / 2 - game.baseWidth / 2, baseY - 14, game.baseWidth, 28, 14); ctx.fill(); ctx.stroke();
  if (!game.active && !game.over) {
    const sprite = pendingSprite();
    const x = pendingX(sprite);
    const y = spawnPosition();
    const halfHeight = pendingHalfExtents(sprite).y;
    ctx.save();
    ctx.strokeStyle = '#63bbe1';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    ctx.moveTo(x, y + halfHeight);
    ctx.lineTo(x, Math.min(baseY - 25, H));
    ctx.stroke();
    ctx.restore();
    drawSprite(ctx, sprite, x, y, game.pendingAngle, .75);
  }
  for (const body of game.blocks) {
    const { sprite, offsetX, offsetY } = body.plugin.text;
    drawSprite(ctx, sprite, body.position.x, body.position.y, body.angle, 1, offsetX, offsetY);
  }
  for (const particle of game.particles) {
    ctx.globalAlpha = Math.max(0, particle.life / 45);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.restore();
}
function updateViewScale() {
  const baseY = game.base.position.y;
  const top = Math.min(
    game.spawnY - pendingSprite().height / 2 - 12,
    ...game.blocks.map(block => block.bounds.min.y - 12),
  );
  const target = Math.min(1, Math.max(0.1, (baseY - game.topPadding) / Math.max(1, baseY - top)));
  game.viewScale += (target - game.viewScale) * .12;
}
function loop(now) {
  if (!game) return;
  const delta = Math.min(40, now - lastFrame || 16.7);
  lastFrame = now;
  if (!game.paused && !game.over) {
    game.accumulator = Math.min(50, game.accumulator + delta);
    while (game.accumulator >= 8.333) {
      Engine.update(game.engine, 8.333);
      settlePiece();
      game.accumulator -= 8.333;
    }
    checkLoss();
    for (const particle of game.particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += .08;
      particle.life--;
    }
    game.particles = game.particles.filter(p => p.life > 0);
  }
  updateViewScale();
  draw();
  frame = requestAnimationFrame(loop);
}

const openInvitation = new URLSearchParams(location.search);
home();
if (openInvitation.has('ranking')) showRanking();
else if (openInvitation.has('multi') || openInvitation.has('room')) showMultiplayer();
