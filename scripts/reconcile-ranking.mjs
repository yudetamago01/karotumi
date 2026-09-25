#!/usr/bin/env node
// Compare every linked account's stored best with the live ranking table and
// raise rows only when a recovered best is higher. Never lowers a score.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reconcile-ranking.mjs
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reconcile-ranking.mjs --dry-run
//   ... node scripts/reconcile-ranking.mjs --from recovery.json
//
// recovery.json: [{ "userId": "...", "name": "...", "avatar": null, "bestCount": 24 }, ...]

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const fromIndex = process.argv.indexOf('--from');
const fromPath = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;

async function rest(path, init = {}) {
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const rows = await rest(
  'karotter_stack_solo_scores?select=user_id,display_name,avatar_url,best_count,achieved_at&order=best_count.desc,achieved_at.asc',
);
console.log(`ランキング表: ${rows.length} 件`);

const recovered = fromPath
  ? JSON.parse(await (await import('node:fs/promises')).readFile(fromPath, 'utf8'))
  : [];
if (fromPath) console.log(`復旧リスト: ${recovered.length} 件`);

const byUser = new Map(rows.map(row => [row.user_id, row]));
let raised = 0;
let unchanged = 0;
let invalid = 0;

for (const entry of recovered) {
  const count = Number(entry.bestCount);
  const userId = String(entry.userId || '');
  if (!userId || !Number.isSafeInteger(count) || count < 1 || count > 10000) {
    invalid++;
    console.warn(`skip invalid`, entry);
    continue;
  }
  const current = byUser.get(userId);
  const currentBest = Number(current?.best_count) || 0;
  if (count <= currentBest) {
    unchanged++;
    continue;
  }
  raised++;
  console.log(`${userId} ${entry.name || current?.display_name || ''}: ${currentBest} → ${count}`);
  if (!dryRun) {
    await rest('rpc/karotter_stack_submit_score', {
      method: 'POST',
      body: JSON.stringify({
        p_user_id: userId,
        p_display_name: String(entry.name || current?.display_name || 'player').slice(0, 40),
        p_avatar_url: entry.avatar || current?.avatar_url || null,
        p_count: count,
      }),
    });
  }
}

const after = await rest(
  'karotter_stack_solo_scores?select=user_id,display_name,best_count&order=best_count.desc,achieved_at.asc&limit=50',
);
console.log('\n=== 更新後の上位 ===');
for (const [index, row] of after.entries()) {
  console.log(`${index + 1}. ${row.display_name} — ${row.best_count}こ (${row.user_id})`);
}
console.log(`\nraised=${raised} unchanged=${unchanged} invalid=${invalid} dryRun=${dryRun}`);
