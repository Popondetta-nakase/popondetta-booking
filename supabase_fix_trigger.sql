-- 新規会員登録時のトリガー関数を修正
-- （supabase_auth_admin ロールから実行されるため public スキーマを明示する必要がある）
create or replace function handle_new_customer()
returns trigger as $$
begin
  insert into public.customer_profiles (user_id, name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'phone', '')
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;
