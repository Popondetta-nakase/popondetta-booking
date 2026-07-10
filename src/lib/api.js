import { supabase } from "./supabaseClient";

/* ============================================================
   店舗
   ============================================================ */
export async function fetchStores() {
  const { data, error } = await supabase
    .from("stores")
    .select("id, name, lane_count, open_min, close_min")
    .order("id");
  if (error) throw error;
  return data.map((s) => ({
    id: s.id,
    name: s.name,
    lanes: s.lane_count,
    openMin: s.open_min,
    closeMin: s.close_min,
  }));
}

/* ============================================================
   顧客向け：空き状況（個人情報を含まない公開ビュー）
   ============================================================ */
export async function fetchReservationSlots(storeId, fromDate, toDate) {
  const { data, error } = await supabase
    .from("reservation_slots")
    .select("store_id, lane_number, date, start_min, duration_min")
    .eq("store_id", storeId)
    .gte("date", fromDate)
    .lte("date", toDate);
  if (error) throw error;
  return data.map((r) => ({
    storeId: r.store_id,
    lane: r.lane_number,
    date: r.date,
    start: r.start_min,
    duration: r.duration_min,
  }));
}

/* ============================================================
   顧客本人の予約一覧（RLSにより自分の予約のみ返る）
   ============================================================ */
export async function fetchMyReservations() {
  const { data, error } = await supabase
    .from("reservations")
    .select("id, store_id, lane_number, date, start_min, duration_min, name, phone, status")
    .eq("status", "confirmed")
    .order("date", { ascending: true })
    .order("start_min", { ascending: true });
  if (error) throw error;
  return data.map(mapReservationRow);
}

/* ============================================================
   予約作成（book_lane_slot RPC 経由。営業時間・重複はDB側で検証）
   ============================================================ */
export async function bookLaneSlot({ storeId, lane, date, start, duration }) {
  const { data, error } = await supabase.rpc("book_lane_slot", {
    p_store_id: storeId,
    p_lane: lane,
    p_date: date,
    p_start: start,
    p_duration: duration,
  });
  if (error) throw error;
  return mapReservationRow(data);
}

/* ============================================================
   顧客による予約キャンセル（自分の予約のみRLSで許可される）
   ============================================================ */
export async function cancelReservation(id) {
  const { error } = await supabase
    .from("reservations")
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) throw error;
}

/* ============================================================
   スタッフ向け：自店舗の予約一覧（RLSで自店舗以外は返らない）
   ============================================================ */
export async function fetchStaffReservations(storeId, date) {
  const { data, error } = await supabase
    .from("reservations")
    .select("id, store_id, lane_number, date, start_min, duration_min, name, phone, source, status, customer_id")
    .eq("store_id", storeId)
    .eq("date", date)
    .eq("status", "confirmed");
  if (error) throw error;
  return data.map(mapReservationRow);
}

export async function staffCreateReservation({ storeId, lane, date, start, duration, name, phone }) {
  const { data, error } = await supabase
    .from("reservations")
    .insert({
      store_id: storeId,
      lane_number: lane,
      date,
      start_min: start,
      duration_min: duration,
      name,
      phone,
      source: "counter",
    })
    .select()
    .single();
  if (error) throw error;
  return mapReservationRow(data);
}

export async function staffUpdateReservation(id, { start, duration, name, phone }) {
  const { data, error } = await supabase
    .from("reservations")
    .update({ start_min: start, duration_min: duration, name, phone })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return mapReservationRow(data);
}

export async function staffCancelReservation(id) {
  const { error } = await supabase
    .from("reservations")
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) throw error;
}

function mapReservationRow(r) {
  return {
    id: r.id,
    storeId: r.store_id,
    lane: r.lane_number,
    date: r.date,
    start: r.start_min,
    duration: r.duration_min,
    name: r.name,
    phone: r.phone,
    source: r.source,
    status: r.status,
    customerId: r.customer_id,
  };
}

/* ============================================================
   認証・プロフィール
   ============================================================ */
export async function signUpCustomer({ name, email, phone, password }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name, phone } },
  });
  if (error) throw error;
  return data;
}

export async function signInWithPassword({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function fetchCustomerProfile(userId) {
  const { data, error } = await supabase
    .from("customer_profiles")
    .select("user_id, name, phone")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchStaffProfile(userId) {
  const { data, error } = await supabase
    .from("staff_profiles")
    .select("user_id, store_id, name, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
