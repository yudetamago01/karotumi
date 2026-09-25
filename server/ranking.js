const cacheMs = 60_000;
const localScores = new Map();
let cache = null;
// Bumped on every improvement so an in-flight leaderboard read cannot
// republish rows that were fetched before the new best was stored.
let cacheGeneration = 0;

function useLocalScores() {
  return process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production';
}

function dbReady() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function dbRequest(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response.json();
}

function asScore(row) {
  return {
    userId: row.user_id,
    name: row.display_name,
    avatar: row.avatar_url,
    bestCount: row.best_count,
    achievedAt: row.achieved_at,
  };
}

function sortLocalRows() {
  return [...localScores.values()]
    .sort((a, b) => b.best_count - a.best_count || a.achieved_at.localeCompare(b.achieved_at))
    .slice(0, 20);
}

function invalidateCache() {
  cacheGeneration++;
  cache = null;
}

export async function leaderboard() {
  if (cache && Date.now() - cache.at < cacheMs) return cache.scores;
  const generation = cacheGeneration;
  let rows;
  if (useLocalScores()) {
    rows = sortLocalRows();
  } else {
    if (!dbReady()) throw new Error('外部DBが未設定です');
    rows = await dbRequest('karotter_stack_solo_scores?select=user_id,display_name,avatar_url,best_count,achieved_at&order=best_count.desc,achieved_at.asc&limit=20');
  }
  const scores = rows.map(asScore);
  if (generation === cacheGeneration) cache = { at: Date.now(), scores };
  return scores;
}

export async function bestCount(userId) {
  if (!userId) return 0;
  if (useLocalScores()) return localScores.get(userId)?.best_count || 0;
  if (!dbReady()) return 0;
  // Bypass the board cache: a personal best must show even outside the top 20.
  const rows = await dbRequest(
    `karotter_stack_solo_scores?user_id=eq.${encodeURIComponent(userId)}&select=best_count&limit=1`,
  );
  return Number(rows?.[0]?.best_count) || 0;
}

export async function submitScore(user, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('記録は1〜10000個で送信してください');
  if (!user?.id || !user?.name) throw new Error('Karotterにログインしてください');
  if (useLocalScores()) {
    const old = localScores.get(user.id);
    const improved = !old || count > old.best_count;
    if (improved) {
      localScores.set(user.id, {
        user_id: user.id, display_name: user.name, avatar_url: user.avatar || null,
        best_count: count, achieved_at: new Date().toISOString(),
      });
      invalidateCache();
    }
    return { bestCount: improved ? count : old.best_count, updated: improved };
  }
  if (!dbReady()) throw new Error('外部DBが未設定です');
  const rows = await dbRequest('rpc/karotter_stack_submit_score', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: user.id, p_display_name: user.name,
      p_avatar_url: user.avatar || null, p_count: count,
    }),
  });
  if (!rows?.length) throw new Error('記録を保存できませんでした');
  if (rows[0].improved) invalidateCache();
  return { bestCount: rows[0].best_count, updated: rows[0].improved };
}
