-- ============================================================
-- 追加機能: 店舗設定（番線数の変更）と予約可能期間の制限
-- Supabase の SQL Editor にそのまま貼り付けて実行できます
-- ============================================================

-- ------------------------------------------------------------
-- 1. スタッフが自店舗の番線数などを変更できるようにする
-- ------------------------------------------------------------
create policy "staff_update_own_store" on stores
  for update using (
    exists (
      select 1 from staff_profiles sp
      where sp.user_id = auth.uid() and sp.store_id = stores.id
    )
  )
  with check (
    exists (
      select 1 from staff_profiles sp
      where sp.user_id = auth.uid() and sp.store_id = stores.id
    )
  );

-- ------------------------------------------------------------
-- 2. 予約作成 RPC に「予約可能期間」の検証を追加
--    お客様がWebから予約できるのは、今日から見て
--    「次の次の金曜日」まで（今日が金曜日でも当日は含めない）
--    ※ スタッフによる電話・店頭登録はこの制限の対象外
-- ------------------------------------------------------------
create or replace function book_lane_slot(
  p_store_id text,
  p_lane int,
  p_date date,
  p_start int,
  p_duration int
) returns reservations as $$
declare
  v_store stores;
  v_profile customer_profiles;
  v_res reservations;
  v_dow int;
  v_days_until_friday int;
  v_cutoff date;
begin
  select * into v_store from stores where id = p_store_id;
  if v_store is null then
    raise exception '店舗が見つかりません';
  end if;

  if p_date < current_date then
    raise exception '過去の日付には予約できません';
  end if;

  v_dow := extract(dow from current_date)::int;
  v_days_until_friday := (5 - v_dow + 7) % 7;
  if v_days_until_friday = 0 then
    v_days_until_friday := 7;
  end if;
  v_cutoff := current_date + (v_days_until_friday + 7);

  if p_date > v_cutoff then
    raise exception 'ご予約は%までとなります', to_char(v_cutoff, 'YYYY-MM-DD');
  end if;

  if p_start < v_store.open_min or (p_start + p_duration) > v_store.close_min then
    raise exception '営業時間外の時間帯です';
  end if;

  if p_lane < 0 or p_lane >= v_store.lane_count then
    raise exception '存在しないレーンです';
  end if;

  select * into v_profile from customer_profiles where user_id = auth.uid();
  if v_profile is null then
    raise exception 'ログインが必要です';
  end if;

  insert into reservations (store_id, lane_number, date, start_min, duration_min, name, phone, customer_id, source)
  values (p_store_id, p_lane, p_date, p_start, p_duration, v_profile.name, v_profile.phone, auth.uid(), 'web')
  returning * into v_res;

  return v_res;
exception
  when exclusion_violation then
    raise exception 'その時間帯は既に予約されています';
end;
$$ language plpgsql security invoker;
