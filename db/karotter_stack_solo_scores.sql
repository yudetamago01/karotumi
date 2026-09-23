-- Isolated solo leaderboard in the existing Supabase project.
create table if not exists public.karotter_stack_solo_scores (
  user_id text primary key,
  display_name text not null,
  avatar_url text,
  best_count integer not null check (best_count between 1 and 10000),
  achieved_at timestamptz not null default now()
);

create index if not exists karotter_stack_solo_scores_rank_idx
  on public.karotter_stack_solo_scores (best_count desc, achieved_at asc);

alter table public.karotter_stack_solo_scores enable row level security;
revoke all on public.karotter_stack_solo_scores from anon, authenticated;
grant select, insert, update on public.karotter_stack_solo_scores to service_role;

create or replace function public.karotter_stack_submit_score(
  p_user_id text, p_display_name text, p_avatar_url text, p_count integer
)
returns table (best_count integer, improved boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_user_id is null or length(p_user_id) = 0 or length(p_user_id) > 200
    or p_display_name is null or length(p_display_name) = 0 or length(p_display_name) > 40
    or p_count is null or p_count < 1 or p_count > 10000 then
    raise exception 'Invalid score submission';
  end if;

  insert into public.karotter_stack_solo_scores
    (user_id, display_name, avatar_url, best_count)
  values (p_user_id, p_display_name, p_avatar_url, p_count)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        best_count = excluded.best_count,
        achieved_at = now()
    where excluded.best_count > public.karotter_stack_solo_scores.best_count;
  get diagnostics affected = row_count;

  return query select s.best_count, affected > 0
    from public.karotter_stack_solo_scores s where s.user_id = p_user_id;
end;
$$;

revoke all on function public.karotter_stack_submit_score(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.karotter_stack_submit_score(text, text, text, integer)
  to service_role;
