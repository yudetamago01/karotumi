import Matter from 'matter-js';
import { TERMS } from './terms.js';
import { splitTerm, makeTextSprite, makeTextBody } from './textBodies.js';
import { openMultiplayer } from './multi.js';
import './style.css';

const { Engine, Bodies, Body, Composite, Events, Sleeping } = Matter;
const app = document.querySelector('#app');
const inks = ['#087bb6', '#1466ad', '#0a91b9', '#456fbd', '#137e9e'];

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

function saveSettings() { localStorage.setItem('karotter-stack-settings', JSON.stringify(settings)); }
function randomTerm() { return TERMS[Math.floor(Math.random() * TERMS.length)]; }

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
  if (name === 'drop') tone(320, .13, 'sine', .10);
  if (name === 'land') { tone(250, .14, 'sine', .16); tone(390, .18, 'sine', .10, .055); }
  if (name === 'score') { tone(523, .13, 'sine', .12); tone(659, .14, 'sine', .12, .10); tone(784, .18, 'sine', .11, .20); }
  if (name === 'over') { tone(392, .18, 'sine', .12); tone(311, .25, 'sine', .13, .13); tone(196, .40, 'sine', .15, .30); }
}
function stopMusic() { if (musicTimer) clearInterval(musicTimer); musicTimer = null; }
function startMusic() {
  stopMusic();
  if (!settings.music) return;
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
    if (document.hidden || !['game', 'home', 'multi'].includes(screen) || game?.paused || game?.over) return;
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
      <button class="button secondary" id="settings-btn">設定</button>
    </div>
  </section>`, 'home-screen');
  document.querySelector('#start-btn').addEventListener('click', () => { sfx('tap'); startGame(); });
  document.querySelector('#multi-btn').addEventListener('click', () => { sfx('tap'); showMultiplayer(); });
  document.querySelector('#settings-btn').addEventListener('click', () => { sfx('tap'); showSettings(); });
  startMusic();
}
async function showMultiplayer() {
  stopGame();
  screen = 'multi';
  const instance = await openMultiplayer(app, () => {
    history.replaceState(null, '', '/');
    home();
  }, sfx);
  if (screen !== 'multi') { instance.destroy(); return; }
  multiplayer = instance;
  startMusic();
}
function showSettings() {
  screen = 'settings';
  stopMusic();
  shell(`<section class="settings-panel">
    <button class="icon-button settings-back" id="back-btn" aria-label="戻る">←</button>
    <h1>設定</h1>
    <div class="setting-row"><span>音楽</span><button class="toggle ${settings.music ? 'on' : ''}" id="music-toggle" role="switch" aria-checked="${settings.music}" aria-label="音楽"><span></span></button></div>
    <div class="setting-row"><span>効果音</span><button class="toggle ${settings.sound ? 'on' : ''}" id="sound-toggle" role="switch" aria-checked="${settings.sound}" aria-label="効果音"><span></span></button></div>
    <div class="setting-row"><span>音量</span><div class="volume-control"><input id="volume-range" type="range" min="0" max="100" value="${settings.volume}" aria-label="音量"><output id="volume-value">${settings.volume}%</output></div></div>
    <a class="reference" href="https://karotter-wiki.vercel.app/index/index.html" target="_blank" rel="noopener noreferrer">参考サイト：カロッター用語辞典 ↗</a>
  </section>`, 'settings-screen');
  document.querySelector('#back-btn').addEventListener('click', () => { sfx('tap'); home(); });
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
  if (game?.resizeObserver) game.resizeObserver.disconnect();
  game = null;
}
function dequeuePiece() {
  if (!game.queue.length) game.queue.push(...splitTerm(randomTerm()));
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
      <button class="icon-button" id="home-btn" aria-label="ホームへ戻る">←</button>
      <div class="stats">
        <div class="stat"><span>つんだ数</span><strong id="score">0</strong></div>
        <div class="stat"><span>次の用語</span><strong id="next-word"></strong></div>
        <div class="stat"><span>ベスト</span><strong id="best-score">${best}</strong></div>
      </div>
      <button class="icon-button" id="pause-btn" aria-label="一時停止">Ⅱ</button>
    </header>
    <div id="overlay-root"></div>`, 'game-screen');
  const canvas = document.querySelector('#stage');
  const engine = Engine.create({ gravity: { x: 0, y: 1.15 }, enableSleeping: true });
  engine.positionIterations = 10;
  engine.velocityIterations = 10;
  engine.constraintIterations = 4;
  game = {
    canvas, ctx: canvas.getContext('2d'), engine, blocks: [], active: null,
    queue: [], pending: null, next: null, score: 0, paused: false, over: false,
    cameraY: 0, targetX: 0, width: 0, height: 0, spawnY: 185,
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
  document.querySelector('#home-btn').addEventListener('click', () => { sfx('tap'); home(); });
  document.querySelector('#pause-btn').addEventListener('click', togglePause);
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
  game.width = rect.width;
  game.height = rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const baseWidth = Math.min(game.width < 600 ? 340 : 740, game.width * (game.width < 600 ? .86 : .78));
  if (!game.base) {
    game.baseWidth = baseWidth;
    game.base = Bodies.rectangle(game.width / 2, game.height - 72, baseWidth, 28, { isStatic: true, label: 'base', friction: 1.1 });
    Composite.add(engine.world, game.base);
    game.targetX = game.width / 2;
  } else {
    const shift = (game.width - oldWidth) / 2;
    if (game.baseWidth !== baseWidth) Body.scale(game.base, baseWidth / game.baseWidth, 1);
    game.baseWidth = baseWidth;
    Body.setPosition(game.base, { x: game.width / 2, y: game.height - 72 });
    if (Math.abs(shift) > 1) {
      for (const block of game.blocks) Body.setPosition(block, { x: block.position.x + shift, y: block.position.y });
      game.targetX += shift;
    }
  }
}
function onPointerMove(event) {
  if (!game || game.paused || game.over) return;
  const rect = game.canvas.getBoundingClientRect();
  game.targetX = Math.max(20, Math.min(game.width - 20, event.clientX - rect.left));
}
function onPointerDown(event) {
  if (!game || game.paused || game.over) return;
  event.preventDefault();
  onPointerMove(event);
  drop();
}
function onKeyDown(event) {
  if (screen !== 'game' || !game) return;
  if (['ArrowLeft', 'ArrowRight', 'Space', 'Escape'].includes(event.code)) event.preventDefault();
  if (event.code === 'Escape') { togglePause(); return; }
  if (game.paused || game.over) return;
  if (event.code === 'ArrowLeft') game.targetX = Math.max(20, game.targetX - 24);
  if (event.code === 'ArrowRight') game.targetX = Math.min(game.width - 20, game.targetX + 24);
  if (event.code === 'Space') drop();
}
function spawnPosition() {
  return game.spawnY;
}
function pendingSprite() {
  return makeTextSprite(game.pending, game.width, inks[game.blocks.length % inks.length]);
}
function drop() {
  if (!game || game.active || game.paused || game.over) return;
  const sprite = pendingSprite();
  const x = Math.max(sprite.width / 2 + 6, Math.min(game.width - sprite.width / 2 - 6, game.targetX));
  const body = makeTextBody(sprite, x, spawnPosition());
  Composite.add(game.engine.world, body);
  game.blocks.push(body);
  game.active = body;
  game.landing = false;
  game.landingTicks = 0;
  game.stableTicks = 0;
  sfx('drop');
}
function settlePiece() {
  if (!game?.active || game.over || !game.landing) return;
  const body = game.active;
  game.landingTicks++;
  if (body.speed < .65 && body.angularSpeed < .025) game.stableTicks++;
  else game.stableTicks = 0;
  if (game.landingTicks < 30 || (game.stableTicks < 16 && game.landingTicks < 170)) return;
  // A resting piece sleeps to stop tiny contact vibrations. The next impact
  // wakes it, so the whole pile can still tilt and fall.
  if (game.stableTicks >= 16) Sleeping.set(body, true);
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
  const highest = game.blocks.reduce((y, block) => Math.min(y, block.bounds.min.y), game.base.position.y);
  game.spawnY = Math.min(185, highest - 155);
  game.pending = game.next;
  game.next = dequeuePiece();
  document.querySelector('#next-word').textContent = game.next.text;
}
function checkLoss() {
  if (!game || game.over) return;
  for (const body of game.blocks) {
    if (body.position.y > game.base.position.y + 95 || body.bounds.max.x < -10 || body.bounds.min.x > game.width + 10) {
      gameOver();
      break;
    }
  }
}
function gameOver() {
  if (!game || game.over) return;
  game.over = true;
  sfx('over');
  stopMusic();
  document.querySelector('#overlay-root').innerHTML = `<div class="overlay"><section class="modal">
    <h2>ゲームオーバー</h2><p class="result">${game.score}<span>こ</span></p>
    <p class="modal-best">ベスト ${best}</p>
    <button class="button primary" id="again-btn">もういちど</button>
    <button class="button secondary" id="end-home-btn">ホームへ</button>
  </section></div>`;
  document.querySelector('#again-btn').addEventListener('click', () => { sfx('tap'); startGame(); });
  document.querySelector('#end-home-btn').addEventListener('click', () => { sfx('tap'); home(); });
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
  </section></div>`;
  document.querySelector('#resume-btn').addEventListener('click', togglePause);
  document.querySelector('#restart-btn').addEventListener('click', () => { sfx('tap'); startGame(); });
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
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#dff6ff';
  ctx.fillRect(0, 0, W, H);
  const cam = game.cameraY;
  const baseY = base.position.y - cam;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#176eaa';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(W / 2 - game.baseWidth / 2, baseY - 14, game.baseWidth, 28, 14); ctx.fill(); ctx.stroke();
  if (!game.active && !game.over) {
    const sprite = pendingSprite();
    const x = Math.max(sprite.width / 2 + 6, Math.min(W - sprite.width / 2 - 6, game.targetX));
    const y = spawnPosition() - cam;
    ctx.save();
    ctx.strokeStyle = '#63bbe1';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    ctx.moveTo(x, y + sprite.height / 2);
    ctx.lineTo(x, Math.min(baseY - 25, H));
    ctx.stroke();
    ctx.restore();
    drawSprite(ctx, sprite, x, y, 0, .75);
  }
  for (const body of game.blocks) {
    const { sprite, offsetX, offsetY } = body.plugin.text;
    drawSprite(ctx, sprite, body.position.x, body.position.y - cam, body.angle, 1, offsetX, offsetY);
  }
  for (const particle of game.particles) {
    ctx.globalAlpha = Math.max(0, particle.life / 45);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(particle.x, particle.y - cam, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
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
    const targetCamera = Math.min(0, spawnPosition() - 176);
    game.cameraY += (targetCamera - game.cameraY) * .065;
  }
  draw();
  frame = requestAnimationFrame(loop);
}

const openInvitation = new URLSearchParams(location.search);
home();
if (openInvitation.has('multi') || openInvitation.has('room')) showMultiplayer();
