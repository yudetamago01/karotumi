import { makeTextSprite } from './textBodies.js';
import { TERM_DEFINITIONS } from './termDefinitions.js';
import { bindHoldRotation, rotationIcon } from './rotationControls.js';
import { multiStageView } from './multiStageView.js';

const colors = ['#087bb6', '#1466ad', '#0a91b9', '#456fbd', '#137e9e'];
const WORLD_W = 1000;
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || (import.meta.env.DEV ? 'http://127.0.0.1:3001' : '');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function avatarMarkup(user, className = 'avatar') {
  const name = String(user?.name || '?');
  if (user?.avatar) {
    return `<img class="${className}" src="${escapeHtml(user.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  return `<span class="${className} avatar-fallback" aria-hidden="true">${escapeHtml([...name][0] || '?')}</span>`;
}

async function api(path, body) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `接続エラー (${response.status})`);
  return data;
}

export async function openMultiplayer(app, onHome, sfx) {
  await document.fonts.ready;
  const model = {
    config: null, user: null, room: null, stream: null, frame: 0,
    disposed: false, x: 500, rotation: 0, dragPointerId: null, drawn: [], display: new Map(),
    sprites: new Map(), lastDraw: 0, lastReconnectProbe: 0, lastShapeTerm: null, chatCount: 0, notice: '',
    authCheckInFlight: false,
  };

  const showError = message => {
    model.notice = message;
    const target = app.querySelector('#multi-notice');
    if (target) target.textContent = message;
  };

  async function run(action) {
    try { await action(); showError(''); }
    catch (error) { showError(error.message); }
  }

  async function refreshAuth() {
    if (model.disposed || model.user || model.authCheckInFlight || !app.querySelector('.multi-entry')) return;
    model.authCheckInFlight = true;
    try {
      const { user } = await api('/api/me');
      if (!user || model.disposed || !app.querySelector('.multi-entry')) return;
      model.user = user;
      renderEntry();
      const roomId = new URLSearchParams(location.search).get('room');
      if (roomId) {
        try { enterRoom((await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {})).room); }
        catch (error) { showError(error.message); }
      }
    } catch { /* The original page may still be waiting for OAuth. */ }
    finally { model.authCheckInFlight = false; }
  }

  const onAuthReturn = () => { if (!document.hidden) void refreshAuth(); };
  window.addEventListener('pageshow', onAuthReturn);
  window.addEventListener('focus', onAuthReturn);
  document.addEventListener('visibilitychange', onAuthReturn);

  function renderEntry() {
    if (model.disposed) return;
    model.rotationCleanup?.();
    model.rotationCleanup = null;
    if (model.onRotateKey) window.removeEventListener('keydown', model.onRotateKey);
    model.onRotateKey = null;
    model.dragPointerId = null;
    model.stream?.close();
    model.stream = null;
    cancelAnimationFrame(model.frame);
    const invitationId = new URLSearchParams(location.search).get('room') || '';
    const auth = model.user ? `
      <div class="multi-user">${escapeHtml(model.user.name)} <button class="tiny-button" id="logout-btn">ログアウト</button></div>
      <div class="multi-forms">
        <form id="create-form" class="multi-card">
          <h2>ルームをつくる</h2>
          <label>パスワード（任意）<input name="password" type="password" maxlength="72" autocomplete="new-password" placeholder="なしでもOK"></label>
          <button class="button primary" type="submit">作成</button>
        </form>
        <form id="join-form" class="multi-card">
          <h2>ルームに入る</h2>
          <label>ルームID<input name="id" maxlength="8" required autocapitalize="characters" placeholder="例: A1B2C3D4" value="${escapeHtml(invitationId)}"></label>
          <label>パスワード<input name="password" type="password" maxlength="72" placeholder="設定されている場合"></label>
          <button class="button secondary" type="submit">参加</button>
        </form>
      </div>` : model.config?.devLogin ? `
      <form id="dev-login-form" class="multi-card multi-login">
        <h2>ローカルテスト</h2>
        <label>名前<input name="name" maxlength="24" required placeholder="名前"></label>
        <button class="button primary" type="submit">テスト参加</button>
      </form>` : `
      <div class="multi-card multi-login">
        <h2>Karotterでログイン</h2>
        <a class="button primary multi-login-link ${model.config?.oauthReady ? '' : 'disabled'}" href="${model.config?.oauthReady ? `${API_ORIGIN}/auth/start${invitationId ? `?room=${encodeURIComponent(invitationId)}` : ''}` : '#'}">ログイン</a>
        ${model.config?.oauthReady ? '' : '<p>OAuthアプリの設定後に利用できます。</p>'}
      </div>`;
    app.innerHTML = `<main class="app-shell multi-entry">
      <button class="icon-button multi-home" id="multi-home" aria-label="ホームへ戻る">←</button>
      <section class="multi-entry-center"><h1>みんなで積む</h1>${auth}<p id="multi-notice" class="multi-notice" role="status">${escapeHtml(model.notice)}</p></section>
    </main>`;
    app.querySelector('#multi-home').addEventListener('click', onHome);
    app.querySelector('#logout-btn')?.addEventListener('click', () => {
      sfx('exit');
      run(async () => {
        await api('/auth/logout', {});
        model.user = null;
        renderEntry();
      });
    });
    app.querySelector('#dev-login-form')?.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = new FormData(event.currentTarget).get('name');
        model.user = (await api('/auth/dev', { name })).user;
        renderEntry();
      });
    });
    app.querySelector('#create-form')?.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const password = new FormData(event.currentTarget).get('password');
        const { room } = await api('/api/rooms', { password });
        enterRoom(room);
      });
    });
    app.querySelector('#join-form')?.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const form = new FormData(event.currentTarget);
        const id = String(form.get('id')).trim().toUpperCase();
        const { room } = await api(`/api/rooms/${encodeURIComponent(id)}/join`, { password: form.get('password') });
        enterRoom(room);
      });
    });
  }

  function statusLists() {
    const playing = model.room.members.filter(m => m.status === 'playing');
    const watching = model.room.members.filter(m => m.status === 'watching' || m.status === 'eliminated');
    const leaderId = model.room.leaderId || model.room.hostId;
    const memberItem = m => `<li class="${m.id === model.room.currentPlayerId ? 'current' : ''}">${avatarMarkup(m, 'member-avatar')}<span>${escapeHtml(m.name)}${m.id === leaderId ? '（リーダー）' : ''}${m.id === model.room.currentPlayerId ? ' ●' : ''}</span></li>`;
    const playerList = playing.map(memberItem).join('');
    const watcherList = watching.map(m => `<li>${avatarMarkup(m, 'member-avatar')}<span>${escapeHtml(m.name)}${m.id === leaderId ? '（リーダー）' : ''}${m.status === 'eliminated' ? '（脱落）' : ''}</span></li>`).join('');
    app.querySelector('#playing-list').innerHTML = playerList || '<li>なし</li>';
    app.querySelector('#watching-list').innerHTML = watcherList || '<li>なし</li>';
    app.querySelector('#member-count').textContent = `${playing.length}・観戦${watching.length}`;
    app.querySelector('#member-toggle').setAttribute('aria-label', `プレイ中${playing.length}人、観戦中${watching.length}人。メンバー一覧を開閉`);
  }

  function renderMessages() {
    const box = app.querySelector('#chat-messages');
    if (!box) return;
    const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 35;
    box.innerHTML = model.room.messages.map(m => `<div class="chat-line"><div class="chat-author">${avatarMarkup(m, 'chat-avatar')}<b>${escapeHtml(m.name)}</b></div><span>${escapeHtml(m.body)}</span></div>`).join('');
    if (wasAtBottom || model.chatCount === 0) box.scrollTop = box.scrollHeight;
    model.chatCount = model.room.messages.length;
  }

  function renderRoomState() {
    const room = model.room;
    if (!room || !app.querySelector('#multi-stage')) return;
    if (room.phase === 'lobby') {
      model.display.clear();
      model.drawn = [];
      model.lastShapeTerm = null;
    }
    app.querySelector('#room-id').textContent = room.id;
    const phase = room.phase === 'lobby' ? '開始待ち' : room.phase === 'ended' ? '終了' : 'プレイ中';
    app.querySelector('#room-phase').textContent = phase;
    const turnPlayer = room.members.find(m => m.id === room.currentPlayerId);
    app.querySelector('#turn-name').textContent = room.phase === 'ended'
      ? (room.members.find(m => m.id === room.winnerId)?.name || '勝者なし')
      : room.phase === 'lobby' ? '参加者を待っています' : `${turnPlayer?.name || '接続待ち'} の番`;
    app.querySelector('#next-term').textContent = room.term || '—';
    const me = room.members.find(m => m.id === model.user.id);
    const leaderId = room.leaderId || room.hostId;
    const leader = room.members.find(m => m.id === leaderId);
    app.querySelector('#leader-name').textContent = leader ? `ゲームリーダー：${leader.name}` : '';
    const ownTurn = room.phase === 'playing' && room.currentPlayerId === model.user.id && me?.status === 'playing' && room.turnDeadline > 0;
    app.querySelector('#drop-help').textContent = ownTurn
      ? (matchMedia('(pointer: coarse)').matches ? '指で動かし、離すと落下' : 'Q/E またはボタンで回転・クリックで落とす') : '';
    app.querySelector('#multi-rotate-left').disabled = !ownTurn;
    app.querySelector('#multi-rotate-right').disabled = !ownTurn;
    app.querySelector('#start-room').hidden = !(room.phase === 'lobby' && leaderId === model.user.id);
    app.querySelector('#start-room').disabled = room.members.filter(m => m.status === 'playing').length < 2;
    app.querySelector('#loss-choice').hidden = me?.status !== 'eliminated';
    app.querySelector('#winner-banner').hidden = room.phase !== 'ended';
    app.querySelector('#winner-banner').textContent = room.phase === 'ended' ? `${room.members.find(m => m.id === room.winnerId)?.name || '勝者なし'} の勝ち！` : '';
    statusLists();
    renderMessages();
    const shapeTurn = `${room.term}:${room.turnDeadline}`;
    if (room.phase === 'playing' && room.term && room.turnDeadline > 0 && room.currentPlayerId === model.user.id && model.lastShapeTerm !== shapeTurn) {
      model.rotation = 0;
      model.lastShapeTerm = shapeTurn;
      const sprite = spriteFor(room.term);
      api(`/api/rooms/${room.id}/shape`, shapeFor(room.term, sprite)).catch(() => {});
    }
  }

  function spriteFor(term) {
    if (model.sprites.has(term)) return model.sprites.get(term);
    const sprite = makeTextSprite({ text: term, emoji: /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(term) }, WORLD_W, colors[term.length % colors.length]);
    model.sprites.set(term, sprite);
    return sprite;
  }
  function shapeFor(term, sprite) {
    return { term, width: sprite.width, height: sprite.height, rectangles: sprite.rectangles };
  }

  function gameFrame(now = performance.now()) {
    if (model.disposed || !model.room || !app.querySelector('#multi-stage')) return;
    // The server sends moving positions at 6Hz. Rendering this view
    // at 30fps is enough for interpolation and avoids making every compound
    // text mask redraw at the full monitor refresh rate.
    if (now - model.lastDraw < 33) {
      model.frame = requestAnimationFrame(gameFrame);
      return;
    }
    model.lastDraw = now;
    const canvas = app.querySelector('#multi-stage');
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#dff6ff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    const view = multiStageView(rect.width, rect.height, model.room.spawnY ?? 160);
    model.view = view;
    const { scale } = view;
    const wx = view.screenX;
    const wy = view.screenY;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#176eaa';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(wx(150), wy(636), wx(700), 28 * scale, 14 * scale);
    ctx.fill(); ctx.stroke();
    const room = model.room;
    const ownTurn = room.phase === 'playing' && room.currentPlayerId === model.user.id && room.turnDeadline > 0;
    if (ownTurn && room.term) {
      const sprite = spriteFor(room.term);
      const rotatedHalfWidth = Math.abs(Math.cos(model.rotation)) * sprite.width / 2 + Math.abs(Math.sin(model.rotation)) * sprite.height / 2;
      const x = Math.max(rotatedHalfWidth + 6, Math.min(WORLD_W - rotatedHalfWidth - 6, model.x));
      ctx.globalAlpha = .72;
      ctx.save();
      ctx.translate(wx(x), wy(room.spawnY));
      ctx.rotate(model.rotation);
      ctx.drawImage(sprite.canvas, -sprite.width * scale / 2, -sprite.height * scale / 2, sprite.width * scale, sprite.height * scale);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    model.drawn = [];
    for (const [index, piece] of room.pieces.entries()) {
      const sprite = spriteFor(piece.term);
      const previous = model.display.get(piece.id) || { x: piece.x, y: piece.y, angle: piece.angle };
      previous.x += (piece.x - previous.x) * .35;
      previous.y += (piece.y - previous.y) * .35;
      previous.angle += (piece.angle - previous.angle) * .35;
      model.display.set(piece.id, previous);
      const sx = wx(previous.x);
      const sy = wy(previous.y);
      const cosine = Math.cos(previous.angle);
      const sine = Math.sin(previous.angle);
      const renderedHeight = (Math.abs(cosine) * sprite.height + Math.abs(sine) * sprite.width) * scale;
      if (sy + renderedHeight / 2 < -80 || sy - renderedHeight / 2 > rect.height + 80) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(previous.angle);
      ctx.drawImage(sprite.canvas, (piece.offsetX - sprite.width / 2) * scale, (piece.offsetY - sprite.height / 2) * scale, sprite.width * scale, sprite.height * scale);
      ctx.restore();
      model.drawn.push({
        term: piece.term,
        x: sx + (piece.offsetX * cosine - piece.offsetY * sine) * scale,
        y: sy + (piece.offsetX * sine + piece.offsetY * cosine) * scale,
        w: sprite.width * scale, h: sprite.height * scale, angle: previous.angle, index,
      });
    }
    const timer = app.querySelector('#turn-timer');
    if (timer) timer.textContent = room.turnDeadline ? `${Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000))}秒` : '—';
    model.frame = requestAnimationFrame(gameFrame);
  }

  function enterRoom(room) {
    model.rotationCleanup?.();
    model.rotationCleanup = null;
    if (model.onRotateKey) window.removeEventListener('keydown', model.onRotateKey);
    model.onRotateKey = null;
    model.room = room;
    model.x = 500;
    model.view = null;
    model.display.clear();
    model.lastShapeTerm = null;
    model.chatCount = 0;
    model.stream?.close();
    cancelAnimationFrame(model.frame);
    history.replaceState(null, '', `/?room=${encodeURIComponent(room.id)}`);
    app.innerHTML = `<main class="app-shell multi-room">
      <section class="multi-field">
        <header class="multi-hud">
          <div class="multi-pill">ROOM <strong id="room-id"></strong> <button class="tiny-button" id="copy-id">コピー</button></div>
          <div class="multi-pill" id="room-phase"></div>
          <div class="multi-pill" id="turn-timer">—</div>
        </header>
        <canvas id="multi-stage" aria-label="みんなで積むゲーム画面"></canvas>
        <div class="rotation-controls" aria-label="用語の回転"><button class="rotate-button" id="multi-rotate-left" type="button" aria-label="用語を左に15度回転" title="左に回転（Q）">${rotationIcon(-1)}<span class="rotate-step">15°</span></button><button class="rotate-button" id="multi-rotate-right" type="button" aria-label="用語を右に15度回転" title="右に回転（E）"><span class="rotate-step">15°</span>${rotationIcon(1)}</button></div>
        <div class="multi-turn"><strong id="turn-name"></strong><span id="next-term"></span><small id="drop-help"></small></div>
        <div id="winner-banner" class="winner-banner" hidden></div>
        <div id="loss-choice" class="loss-choice" hidden><strong>脱落しました</strong><button class="button primary" id="watch-btn">観戦する</button><button class="button secondary" id="exit-btn">退出する</button></div>
      </section>
      <aside class="multi-side">
        <div class="multi-side-head"><button class="member-toggle" id="member-toggle" type="button" aria-controls="multi-members" aria-expanded="false">メンバー <span id="member-count">0・観戦0</span></button><div class="member-heading"><strong>メンバー</strong><small id="leader-name"></small></div><button class="tiny-button" id="leave-btn">退出</button></div>
        <div class="multi-members" id="multi-members"><div class="member-group"><h3>プレイ中</h3><ul id="playing-list"></ul></div>
        <div class="member-group"><h3>観戦中</h3><ul id="watching-list"></ul></div></div>
        <button class="button primary multi-start" id="start-room">ゲーム開始</button>
        <section class="chat-panel"><h3>チャット</h3><div id="chat-messages" class="chat-messages"></div>
          <form id="chat-form"><input name="body" maxlength="200" autocomplete="off" placeholder="メッセージ"><button type="submit" aria-label="送信">➤</button></form>
        </section>
        <p id="multi-notice" class="multi-notice" role="status"></p>
      </aside>
      <div id="term-dialog" class="term-dialog" hidden><section><button id="close-term" aria-label="閉じる">×</button><h2 id="term-title"></h2><p id="term-description"></p></section></div>
      <div id="leave-dialog" class="term-dialog" hidden><section class="leave-confirm"><h2>ルームから退出しますか？</h2><p>参加中のルームから退出します。</p><div><button id="cancel-leave" class="button secondary">キャンセル</button><button id="confirm-leave" class="button primary">退出する</button></div></section></div>
    </main>`;
    const leaveDialog = app.querySelector('#leave-dialog');
    const memberToggle = app.querySelector('#member-toggle');
    const memberPanel = app.querySelector('#multi-members');
    memberToggle.addEventListener('click', () => {
      const open = memberPanel.classList.toggle('open');
      memberToggle.setAttribute('aria-expanded', String(open));
      sfx('tap');
    });
    const requestLeave = () => { sfx('tap'); leaveDialog.hidden = false; };
    app.querySelector('#leave-btn').addEventListener('click', requestLeave);
    app.querySelector('#cancel-leave').addEventListener('click', () => { sfx('back'); leaveDialog.hidden = true; });
    app.querySelector('#confirm-leave').addEventListener('click', () => {
      sfx('exit');
      run(async () => {
        await api(`/api/rooms/${room.id}/leave`, {});
        leaveDialog.hidden = true;
        history.replaceState(null, '', '/');
        renderEntry();
      });
    });
    app.querySelector('#copy-id').addEventListener('click', () => navigator.clipboard.writeText(room.id).then(() => showError('ルームIDをコピーしました')).catch(() => showError('コピーできませんでした')));
    app.querySelector('#start-room').addEventListener('click', () => { sfx('tap'); run(async () => { model.room = (await api(`/api/rooms/${room.id}/start`, {})).room; renderRoomState(); }); });
    app.querySelector('#watch-btn').addEventListener('click', () => run(async () => { model.room = (await api(`/api/rooms/${room.id}/choice`, { choice: 'watching' })).room; renderRoomState(); }));
    app.querySelector('#exit-btn').addEventListener('click', requestLeave);
    app.querySelector('#chat-form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const text = form.elements.body.value.trim();
      if (!text) return;
      run(async () => { await api(`/api/rooms/${room.id}/chat`, { body: text }); form.reset(); });
    });
    const canvas = app.querySelector('#multi-stage');
    canvas.addEventListener('pointerdown', () => {
      memberPanel.classList.remove('open');
      memberToggle.setAttribute('aria-expanded', 'false');
    });
    const rotatePiece = delta => {
      if (model.room.currentPlayerId !== model.user.id || !model.room.turnDeadline) return;
      model.rotation = (model.rotation + delta + Math.PI * 2) % (Math.PI * 2);
      sfx('tap');
    };
    model.rotationCleanup = bindHoldRotation(
      app.querySelector('#multi-rotate-left'), app.querySelector('#multi-rotate-right'),
      direction => rotatePiece(direction * Math.PI / 12),
    );
    const onRotateKey = event => {
      if (!app.querySelector('#multi-stage')) return;
      if (!['KeyQ', 'KeyE'].includes(event.code) || event.repeat || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '')) return;
      event.preventDefault();
      rotatePiece(event.code === 'KeyQ' ? -Math.PI / 12 : Math.PI / 12);
    };
    window.addEventListener('keydown', onRotateKey);
    model.onRotateKey = onRotateKey;
    const movePointer = event => {
      const bounds = canvas.getBoundingClientRect();
      const view = model.view || multiStageView(bounds.width, bounds.height, model.room.spawnY ?? 160);
      model.x = Math.max(0, Math.min(WORLD_W, view.worldX(event.clientX - bounds.left)));
    };
    const dropCurrent = () => {
      if (model.room.currentPlayerId !== model.user.id || !model.room.turnDeadline) return;
      const term = model.room.term;
      const sprite = spriteFor(term);
      run(async () => {
        model.room = (await api(`/api/rooms/${room.id}/drop`, { x: model.x, angle: model.rotation, shape: shapeFor(term, sprite) })).room;
        renderRoomState(); sfx('drop');
      });
    };
    canvas.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse' || model.dragPointerId === event.pointerId) movePointer(event);
    });
    canvas.addEventListener('pointerdown', event => {
      const me = model.room.members.find(m => m.id === model.user.id);
      if (me?.status === 'watching' || me?.status === 'eliminated') {
        const hit = [...model.drawn].reverse().find(item => {
          const dx = event.offsetX - item.x;
          const dy = event.offsetY - item.y;
          const cosine = Math.cos(item.angle);
          const sine = Math.sin(item.angle);
          return Math.abs(dx * cosine + dy * sine) < item.w / 2 && Math.abs(dy * cosine - dx * sine) < item.h / 2;
        });
        if (hit) {
          app.querySelector('#term-title').textContent = hit.term;
          app.querySelector('#term-description').textContent = TERM_DEFINITIONS[hit.term] || 'カロッターの用語です。';
          app.querySelector('#term-dialog').hidden = false;
        }
        return;
      }
      if (model.room.currentPlayerId !== model.user.id || !model.room.turnDeadline) return;
      event.preventDefault();
      if (event.pointerType !== 'mouse') {
        if (model.dragPointerId !== null) return;
        model.dragPointerId = event.pointerId;
        canvas.setPointerCapture(event.pointerId);
      }
      movePointer(event);
      if (event.pointerType === 'mouse') dropCurrent();
    });
    canvas.addEventListener('pointerup', event => {
      if (model.dragPointerId !== event.pointerId) return;
      movePointer(event);
      model.dragPointerId = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      dropCurrent();
    });
    const cancelDrag = event => {
      if (model.dragPointerId === event.pointerId) model.dragPointerId = null;
    };
    canvas.addEventListener('pointercancel', cancelDrag);
    canvas.addEventListener('lostpointercapture', cancelDrag);
    app.querySelector('#close-term').addEventListener('click', () => { app.querySelector('#term-dialog').hidden = true; });
    app.querySelector('#term-dialog').addEventListener('click', event => { if (event.target.id === 'term-dialog') event.currentTarget.hidden = true; });
    model.stream = new EventSource(`${API_ORIGIN}/api/rooms/${room.id}/events`, { withCredentials: true });
    model.stream.addEventListener('state', event => {
      if (model.disposed) return;
      const next = JSON.parse(event.data);
      if (!next.messages) next.messages = model.room?.messages || [];
      model.room = next;
      renderRoomState();
    });
    model.stream.addEventListener('chat', event => {
      if (model.disposed || !model.room) return;
      const message = JSON.parse(event.data);
      if (model.room.messages.some(item => item.id === message.id)) return;
      model.room.messages.push(message);
      model.room.messages = model.room.messages.slice(-50);
      renderMessages();
    });
    model.stream.addEventListener('tick', event => {
      if (model.disposed || !model.room) return;
      const tick = JSON.parse(event.data);
      for (const [index, x, y, angle] of tick.pieces) {
        const piece = model.room.pieces[index];
        if (piece) Object.assign(piece, { x, y, angle });
      }
    });
    model.stream.onerror = () => {
      showError('再接続しています…');
      if (Date.now() - model.lastReconnectProbe < 3000) return;
      model.lastReconnectProbe = Date.now();
      api(`/api/rooms/${room.id}`).then(({ room: freshRoom }) => {
        model.room = freshRoom;
        renderRoomState();
      }).catch(error => {
        if (!/見つかりません/.test(error.message)) return;
        model.notice = 'ルームが終了しました。';
        model.stream?.close();
        model.stream = null;
        history.replaceState(null, '', '/?multi=1');
        renderEntry();
      });
    };
    model.stream.onopen = () => showError('');
    renderRoomState();
    gameFrame();
  }

  try {
    [model.config, { user: model.user }] = await Promise.all([api('/api/config'), api('/api/me')]);
    if (model.disposed) return { destroy() {} };
    renderEntry();
    const roomId = new URLSearchParams(location.search).get('room');
    if (roomId && model.user) {
      try { enterRoom((await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {})).room); }
      catch (error) { showError(error.message); }
    }
  } catch (error) {
    model.notice = error.message;
    renderEntry();
  }

  return {
    destroy() {
      model.disposed = true;
      window.removeEventListener('pageshow', onAuthReturn);
      window.removeEventListener('focus', onAuthReturn);
      document.removeEventListener('visibilitychange', onAuthReturn);
      model.rotationCleanup?.();
      if (model.onRotateKey) window.removeEventListener('keydown', model.onRotateKey);
      model.stream?.close();
      cancelAnimationFrame(model.frame);
      if (location.search.includes('room=')) history.replaceState(null, '', '/');
    },
  };
}
