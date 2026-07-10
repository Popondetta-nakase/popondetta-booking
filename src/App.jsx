import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Calendar, User, Phone, Mail, Lock, Check, X, Plus, Clock, ChevronLeft, ChevronRight, LayoutGrid, Train } from "lucide-react";
import { supabase } from "./lib/supabaseClient";
import {
  fetchStores,
  fetchReservationSlots,
  fetchMyReservations,
  bookLaneSlot,
  cancelReservation,
  fetchStaffReservations,
  staffCreateReservation,
  staffUpdateReservation,
  staffCancelReservation,
  signUpCustomer,
  signInWithPassword,
  signOut,
  fetchCustomerProfile,
  fetchStaffProfile,
  requestPasswordReset,
  updatePassword,
  updateStoreLaneCount,
  countReservationsBeyondLane,
} from "./lib/api";

/* ============================================================
   定数・共通ユーティリティ
   ============================================================ */
const SLOT_MIN = 10;
const DURATIONS = [30, 60, 90, 120];
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function minToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function next10Days() {
  const out = [];
  const today = new Date();
  for (let i = 0; i < 10; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    out.push(d);
  }
  return out;
}
// 顧客の予約可能期間: 今日から見て「次の次の金曜日」まで（今日が金曜でも当日は含めない）
function customerBookableDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  let daysUntilNextFriday = (5 - dow + 7) % 7;
  if (daysUntilNextFriday === 0) daysUntilNextFriday = 7;
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + daysUntilNextFriday + 7);

  const out = [];
  const d = new Date(today);
  while (d <= cutoff) {
    out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function formatDateJp(ds) {
  const d = new Date(ds + "T00:00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_JP[d.getDay()]}）`;
}
function slotCount(store) {
  return (store.closeMin - store.openMin) / SLOT_MIN;
}
function errorMessage(err, fallback) {
  return (err && err.message) || fallback;
}

/* ---------------- 空き状況ロジック（fetchしたスロット配列に対して計算） ---------------- */
function laneBusyIntervals(slots, lane, date) {
  return slots
    .filter((r) => r.lane === lane && r.date === date)
    .map((r) => ({ start: r.start, end: r.start + r.duration, key: r.id ?? `${r.lane}-${r.start}` }));
}
function isFree(store, slots, lane, date, start, duration, excludeId) {
  const end = start + duration;
  if (start < store.openMin || end > store.closeMin) return false;
  const busy = laneBusyIntervals(slots, lane, date).filter((b) => !(excludeId && b.key === excludeId));
  return !busy.some((b) => start < b.end && end > b.start);
}
function availableStarts(store, slots, lane, date, duration) {
  const out = [];
  for (let t = store.openMin; t + duration <= store.closeMin; t += SLOT_MIN) {
    if (isFree(store, slots, lane, date, t, duration)) out.push(t);
  }
  return out;
}

/* ---------------- Realtime購読フック ----------------
   reservations テーブルの変更を監視し、変更があったら onChange を呼ぶ。
   Supabase側で reservations テーブルが Realtime publication に
   追加されていない場合は何も起きないだけで、エラーにはならない。 */
function useReservationsRealtime(storeId, onChange) {
  useEffect(() => {
    if (!storeId) return;
    const channel = supabase
      .channel(`reservations-${storeId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reservations", filter: `store_id=eq.${storeId}` },
        () => onChange()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [storeId, onChange]);
}

/* ============================================================
   App ルート
   ============================================================ */
export default function App() {
  const [stores, setStores] = useState([]);
  const [storesError, setStoresError] = useState("");
  const [storesLoading, setStoresLoading] = useState(true);

  const [storeId, setStoreId] = useState(null);
  const [view, setView] = useState("customer"); // customer | staff

  const [sessionReady, setSessionReady] = useState(false);
  const [session, setSession] = useState(null);

  const [profileReady, setProfileReady] = useState(true);
  const [customerProfile, setCustomerProfile] = useState(null);
  const [staffProfile, setStaffProfile] = useState(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  const refreshStores = useCallback(() => {
    return fetchStores()
      .then((data) => {
        setStores(data);
        setStoreId((prev) => (prev && data.some((s) => s.id === prev) ? prev : data[0]?.id ?? null));
      })
      .catch((err) => setStoresError(errorMessage(err, "店舗情報の取得に失敗しました")));
  }, []);

  // 店舗一覧を取得
  useEffect(() => {
    refreshStores().finally(() => setStoresLoading(false));
  }, [refreshStores]);

  // ログイン状態の監視
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // ログインユーザーが変わったらプロフィール（顧客／スタッフ）を取得
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      setCustomerProfile(null);
      setStaffProfile(null);
      return;
    }
    setProfileReady(false);
    Promise.all([fetchCustomerProfile(userId), fetchStaffProfile(userId)])
      .then(([cust, staff]) => {
        setCustomerProfile(cust);
        setStaffProfile(staff);
      })
      .catch(() => {
        setCustomerProfile(null);
        setStaffProfile(null);
      })
      .finally(() => setProfileReady(true));
  }, [session?.user?.id]);

  const staffStore = staffProfile ? stores.find((s) => s.id === staffProfile.store_id) : null;
  const store = stores.find((s) => s.id === storeId);

  async function logout() {
    await signOut();
  }

  if (passwordRecovery) {
    return (
      <div style={styles.appRoot}>
        <style>{FONT_IMPORT}</style>
        <PasswordRecoveryScreen onDone={() => setPasswordRecovery(false)} />
      </div>
    );
  }

  if (storesLoading) {
    return (
      <div style={styles.appRoot}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.centerLoading}>読み込み中...</div>
      </div>
    );
  }
  if (storesError) {
    return (
      <div style={styles.appRoot}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.centerLoading}>{storesError}</div>
      </div>
    );
  }

  return (
    <div style={styles.appRoot}>
      <style>{FONT_IMPORT}</style>
      <TopBar
        stores={stores}
        storeId={storeId}
        setStoreId={setStoreId}
        view={view}
        setView={setView}
        staffLockedStore={view === "staff" ? staffStore : null}
      />
      <div style={styles.body}>
        {view === "customer" ? (
          <CustomerArea
            store={store}
            stores={stores}
            sessionReady={sessionReady}
            profileReady={profileReady}
            session={session}
            customerProfile={customerProfile}
            logout={logout}
          />
        ) : (
          <StaffArea
            stores={stores}
            sessionReady={sessionReady}
            profileReady={profileReady}
            session={session}
            staffProfile={staffProfile}
            logout={logout}
            refreshStores={refreshStores}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- TopBar ---------------- */
function TopBar({ stores, storeId, setStoreId, view, setView, staffLockedStore }) {
  return (
    <div style={styles.topbar}>
      <div style={styles.topbarLeft}>
        <div style={styles.brandMark}>
          <Train size={18} color="#E8A33D" strokeWidth={2.2} />
        </div>
        <div>
          <div style={styles.brandTitle}>レンタルレイアウト予約</div>
          <div style={styles.brandSub}>POPONDETTA RENTAL TRACK BOOKING</div>
        </div>
      </div>
      <div style={styles.topbarRight}>
        {staffLockedStore ? (
          <div style={styles.storeLockedLabel}>{staffLockedStore.name}（担当店舗）</div>
        ) : (
          <select value={storeId || ""} onChange={(e) => setStoreId(e.target.value)} style={styles.storeSelect}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.lanes}番線）
              </option>
            ))}
          </select>
        )}
        <div style={styles.tabGroup}>
          <button
            onClick={() => setView("customer")}
            style={{ ...styles.tabBtn, ...(view === "customer" ? styles.tabBtnActive : {}) }}
          >
            お客様予約
          </button>
          <button
            onClick={() => setView("staff")}
            style={{ ...styles.tabBtn, ...(view === "staff" ? styles.tabBtnActive : {}) }}
          >
            スタッフ管理
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- レーン空き状況マップ（顧客向け・全レーン一覧） ---------------- */
const MAP_ROW_H = 8;
const MAP_COL_W = 26;

function LaneOverviewMap({ store, slots, date, selectedLane, selectedStart, selectedDuration }) {
  const totalH = slotCount(store) * MAP_ROW_H;
  return (
    <div style={styles.mapCard}>
      <div style={styles.mapHead}>
        <div style={styles.mapTitle}>
          <LayoutGrid size={14} color={AMBER} />
          番線空き状況マップ（全{store.lanes}番線）
        </div>
        <div style={styles.legendRow}>
          <LegendDot color="#B33A3A" label="予約済み" />
          <LegendDot color={AMBER} label="選択中" />
        </div>
      </div>
      <div style={styles.mapScrollV}>
        <div style={{ display: "flex" }}>
          <div style={styles.mapTimeAxis}>
            <div style={styles.mapCornerSm} />
            {Array.from({ length: slotCount(store) }, (_, i) => {
              const t = store.openMin + i * SLOT_MIN;
              const isHour = t % 60 === 0;
              return (
                <div key={i} style={{ ...styles.mapTimeRowLabel, height: MAP_ROW_H }}>
                  {isHour ? minToTime(t) : ""}
                </div>
              );
            })}
          </div>
          {Array.from({ length: store.lanes }, (_, laneIdx) => {
            const busy = laneBusyIntervals(slots, laneIdx, date);
            const isSelectedLane = laneIdx === selectedLane;
            return (
              <div key={laneIdx} style={styles.mapCol}>
                <div style={{ ...styles.mapColHeaderSm, ...(isSelectedLane ? styles.mapLabelActive : {}) }}>{laneIdx + 1}</div>
                <div style={{ ...styles.mapColTrack, height: totalH }}>
                  {busy.map((b) => (
                    <div
                      key={b.key}
                      style={{
                        ...styles.mapBusyBlockV,
                        top: ((b.start - store.openMin) / SLOT_MIN) * MAP_ROW_H,
                        height: ((b.end - b.start) / SLOT_MIN) * MAP_ROW_H,
                      }}
                    />
                  ))}
                  {isSelectedLane && selectedStart !== null && (
                    <div
                      style={{
                        ...styles.mapSelectedBlockV,
                        top: ((selectedStart - store.openMin) / SLOT_MIN) * MAP_ROW_H,
                        height: (selectedDuration / SLOT_MIN) * MAP_ROW_H,
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 顧客エリア（ログインゲート＋予約／マイページ切替） ---------------- */
function CustomerArea({ store, stores, sessionReady, profileReady, session, customerProfile, logout }) {
  const [subview, setSubview] = useState("booking"); // booking | mypage

  if (!sessionReady || !store) {
    return <div style={styles.centerLoading}>読み込み中...</div>;
  }
  if (!session) {
    return <CustomerAuth />;
  }
  if (!profileReady || !customerProfile) {
    return <div style={styles.centerLoading}>プロフィールを読み込み中...</div>;
  }

  const currentUser = {
    name: customerProfile.name,
    phone: customerProfile.phone,
    email: session.user.email,
  };

  return (
    <div style={styles.customerWrap}>
      <UserBar user={currentUser} subview={subview} setSubview={setSubview} logout={logout} />
      {subview === "booking" ? (
        <CustomerBooking store={store} currentUser={currentUser} goMyPage={() => setSubview("mypage")} />
      ) : (
        <MyPage stores={stores} />
      )}
    </div>
  );
}

function UserBar({ user, subview, setSubview, logout }) {
  return (
    <div style={styles.userBar}>
      <div style={styles.userBarLeft}>
        <div style={styles.userAvatar}>{(user.name || "?").slice(0, 1)}</div>
        <div>
          <div style={styles.userBarName}>{user.name || "（お名前未設定）"} 様</div>
          <div style={styles.userBarEmail}>{user.email}</div>
        </div>
      </div>
      <div style={styles.userBarRight}>
        <button
          onClick={() => setSubview("booking")}
          style={{ ...styles.userBarTab, ...(subview === "booking" ? styles.userBarTabActive : {}) }}
        >
          予約する
        </button>
        <button
          onClick={() => setSubview("mypage")}
          style={{ ...styles.userBarTab, ...(subview === "mypage" ? styles.userBarTabActive : {}) }}
        >
          マイページ
        </button>
        <button onClick={logout} style={styles.userBarLogout}>
          ログアウト
        </button>
      </div>
    </div>
  );
}

/* ---------------- ログイン／新規登録（顧客） ---------------- */
function CustomerAuth() {
  const [mode, setMode] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signupDone, setSignupDone] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  async function submit() {
    setAuthError("");
    if (mode === "login") {
      if (!email || !password) return;
      setSubmitting(true);
      try {
        await signInWithPassword({ email, password });
      } catch (err) {
        setAuthError(errorMessage(err, "メールアドレスまたはパスワードが正しくありません"));
      } finally {
        setSubmitting(false);
      }
    } else {
      if (!name || !email || !phone || !password) return;
      setSubmitting(true);
      try {
        const result = await signUpCustomer({ name, email, phone, password });
        // Supabaseの「メール確認」設定が有効な場合はセッションがまだ発行されない
        if (!result.session) {
          setSignupDone(true);
        }
      } catch (err) {
        setAuthError(errorMessage(err, "登録に失敗しました。入力内容をご確認ください"));
      } finally {
        setSubmitting(false);
      }
    }
  }

  if (signupDone) {
    return (
      <div style={styles.authWrap}>
        <div style={styles.authCard}>
          <div style={styles.authBody}>
            <div style={styles.successIconWrap}>
              <Check size={28} color="#fff" />
            </div>
            <h2 style={styles.successTitle}>確認メールを送信しました</h2>
            <div style={styles.helperText}>
              {email} 宛に確認メールを送信しました。メール内のリンクを開いて登録を完了してください。
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (forgotMode) {
    return <ForgotPasswordPanel onBack={() => setForgotMode(false)} />;
  }

  return (
    <div style={styles.authWrap}>
      <div style={styles.authCard}>
        <div style={styles.authTabGroup}>
          <button
            onClick={() => setMode("login")}
            style={{ ...styles.authTab, ...(mode === "login" ? styles.authTabActive : {}) }}
          >
            ログイン
          </button>
          <button
            onClick={() => setMode("signup")}
            style={{ ...styles.authTab, ...(mode === "signup" ? styles.authTabActive : {}) }}
          >
            新規登録
          </button>
        </div>

        <div style={styles.authBody}>
          {mode === "signup" && (
            <div style={styles.formRow}>
              <label style={styles.formLabel}>
                <User size={14} /> お名前
              </label>
              <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 太郎" />
            </div>
          )}
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Mail size={14} /> メールアドレス
            </label>
            <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          {mode === "signup" && (
            <div style={styles.formRow}>
              <label style={styles.formLabel}>
                <Phone size={14} /> 電話番号
              </label>
              <input style={styles.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="090-1234-5678" />
            </div>
          )}
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Lock size={14} /> パスワード
            </label>
            <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8文字以上" />
          </div>

          {authError && <div style={styles.warnText}>{authError}</div>}

          <button style={{ ...styles.primaryBtn, ...(submitting ? styles.primaryBtnDisabled : {}) }} onClick={submit} disabled={submitting}>
            {submitting ? "処理中..." : mode === "login" ? "ログイン" : "登録してはじめる"}
          </button>

          {mode === "login" && (
            <div style={styles.authHint}>
              <button onClick={() => setForgotMode(true)} style={styles.linkBtn}>
                パスワードをお忘れですか？
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- マイページ ---------------- */
function MyPage({ stores }) {
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetchMyReservations()
      .then(setReservations)
      .catch((err) => setError(errorMessage(err, "予約の取得に失敗しました")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCancel(id) {
    try {
      await cancelReservation(id);
      load();
    } catch (err) {
      alert(errorMessage(err, "キャンセルに失敗しました"));
    }
  }

  if (loading) return <div style={styles.section}>読み込み中...</div>;
  if (error) return <div style={styles.section}>{error}</div>;

  if (reservations.length === 0) {
    return (
      <div style={styles.section}>
        <div style={styles.helperText}>まだご予約がありません。「予約する」から新しい予約を作成できます。</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {reservations.map((r) => {
        const st = stores.find((s) => s.id === r.storeId);
        return (
        <div key={r.id} style={styles.myResCard}>
          <div>
            <div style={styles.myResStore}>{st ? st.name : r.storeId}</div>
            <div style={styles.myResDetail}>
              {formatDateJp(r.date)} ・ {r.lane + 1}番線 ・ {minToTime(r.start)}–{minToTime(r.start + r.duration)}（{r.duration}分）
            </div>
          </div>
          <button style={styles.dangerBtn} onClick={() => handleCancel(r.id)}>
            キャンセル
          </button>
        </div>
        );
      })}
    </div>
  );
}

/* ---------------- 顧客予約フロー ---------------- */
function CustomerBooking({ store, currentUser, goMyPage }) {
  const days = useMemo(() => customerBookableDays(), []);
  const [date, setDate] = useState(toDateStr(days[0]));
  const [lane, setLane] = useState(null);
  const [duration, setDuration] = useState(60);
  const [start, setStart] = useState(null);
  const [done, setDone] = useState(null);
  const [bookError, setBookError] = useState("");
  const [booking, setBooking] = useState(false);

  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(true);

  const loadSlots = useCallback(() => {
    setSlotsLoading(true);
    fetchReservationSlots(store.id, toDateStr(days[0]), toDateStr(days[days.length - 1]))
      .then(setSlots)
      .catch(() => setSlots([]))
      .finally(() => setSlotsLoading(false));
  }, [store.id, days]);

  useEffect(() => {
    loadSlots();
  }, [loadSlots]);

  useReservationsRealtime(store.id, loadSlots);

  const laneFreeCounts = useMemo(() => {
    return Array.from({ length: store.lanes }, (_, i) => ({
      lane: i,
      count: availableStarts(store, slots, i, date, 60).length,
    }));
  }, [store, slots, date]);

  useEffect(() => {
    setLane(null);
    setStart(null);
    setDone(null);
    setBookError("");
  }, [date, store.id]);
  useEffect(() => {
    setStart(null);
  }, [duration, lane]);

  const starts = lane !== null ? availableStarts(store, slots, lane, date, duration) : [];

  async function confirm() {
    if (lane === null || start === null) return;
    setBookError("");
    setBooking(true);
    try {
      const res = await bookLaneSlot({ storeId: store.id, lane, date, start, duration });
      setDone(res);
      loadSlots();
    } catch (err) {
      setBookError(errorMessage(err, "予約に失敗しました。もう一度お試しください"));
    } finally {
      setBooking(false);
    }
  }

  if (done) {
    return (
      <div style={styles.stepCard}>
        <div style={styles.successIconWrap}>
          <Check size={28} color="#fff" />
        </div>
        <h2 style={styles.successTitle}>予約が確定しました</h2>
        <div style={styles.ticket}>
          <div style={styles.ticketRow}>
            <span style={styles.ticketLabel}>店舗</span>
            <span style={styles.ticketValue}>{store.name}</span>
          </div>
          <div style={styles.ticketRow}>
            <span style={styles.ticketLabel}>日付</span>
            <span style={styles.ticketValue}>{formatDateJp(done.date)}</span>
          </div>
          <div style={styles.ticketRow}>
            <span style={styles.ticketLabel}>番線</span>
            <span style={styles.ticketValueMono}>{done.lane + 1}番線</span>
          </div>
          <div style={styles.ticketRow}>
            <span style={styles.ticketLabel}>時間</span>
            <span style={styles.ticketValueMono}>
              {minToTime(done.start)} – {minToTime(done.start + done.duration)}（{done.duration}分）
            </span>
          </div>
          <div style={styles.ticketRow}>
            <span style={styles.ticketLabel}>お名前</span>
            <span style={styles.ticketValue}>{done.name}</span>
          </div>
        </div>
        <button style={{ ...styles.primaryBtn, marginTop: 14 }} onClick={() => setDone(null)}>
          もう1件予約する
        </button>
        <button style={styles.secondaryBtn} onClick={goMyPage}>
          マイページで確認する
        </button>
      </div>
    );
  }

  return (
    <div style={styles.customerSteps}>
      <Section num="01" title="日付を選ぶ">
        <div style={styles.dayRow}>
          {days.map((d) => {
            const ds = toDateStr(d);
            const active = ds === date;
            return (
              <button key={ds} onClick={() => setDate(ds)} style={{ ...styles.dayChip, ...(active ? styles.dayChipActive : {}) }}>
                <div style={styles.dayChipWeekday}>{WEEKDAY_JP[d.getDay()]}</div>
                <div style={styles.dayChipNum}>{d.getDate()}</div>
              </button>
            );
          })}
        </div>
        <div style={{ ...styles.helperText, marginTop: 8 }}>
          ご予約は{formatDateJp(toDateStr(days[days.length - 1]))}まで承っております
        </div>
      </Section>

      {slotsLoading ? (
        <div style={styles.section}>空き状況を読み込み中...</div>
      ) : (
        <LaneOverviewMap store={store} slots={slots} date={date} selectedLane={lane} selectedStart={start} selectedDuration={duration} />
      )}

      <Section num="02" title="番線を選ぶ">
        <div style={styles.laneGrid}>
          {laneFreeCounts.map(({ lane: li, count }) => {
            const active = li === lane;
            const full = count === 0;
            return (
              <button
                key={li}
                disabled={full}
                onClick={() => setLane(li)}
                style={{
                  ...styles.laneCard,
                  ...(active ? styles.laneCardActive : {}),
                  ...(full ? styles.laneCardFull : {}),
                }}
              >
                <div style={styles.laneCardNum}>
                  {li + 1}
                  <span style={styles.laneCardSuffix}>番線</span>
                </div>
                <div style={styles.laneCardLabel}>{full ? "満枠" : "空きあり"}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section num="03" title="利用時間を選ぶ">
        <div style={styles.durationRow}>
          {DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDuration(d)}
              style={{ ...styles.durationChip, ...(duration === d ? styles.durationChipActive : {}) }}
            >
              {d}分
            </button>
          ))}
        </div>
      </Section>

      <Section num="04" title="開始時刻を選ぶ" disabled={lane === null}>
        {lane === null ? (
          <div style={styles.helperText}>先に番線を選択してください</div>
        ) : starts.length === 0 ? (
          <div style={styles.helperText}>この条件で空いている時間がありません</div>
        ) : (
          <div style={styles.timeGridWrap}>
            {starts.map((t) => (
              <button
                key={t}
                onClick={() => setStart(t)}
                style={{ ...styles.timeChip, ...(start === t ? styles.timeChipActive : {}) }}
              >
                {minToTime(t)}
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section num="05" title="予約内容を確認して予約する" disabled={start === null}>
        <div style={styles.confirmProfile}>
          <div style={styles.confirmProfileRow}>
            <User size={13} color={INK_SOFT} />
            <span>{currentUser.name} 様</span>
          </div>
          <div style={styles.confirmProfileRow}>
            <Phone size={13} color={INK_SOFT} />
            <span>{currentUser.phone}</span>
          </div>
          <div style={styles.confirmProfileRow}>
            <Mail size={13} color={INK_SOFT} />
            <span>{currentUser.email}</span>
          </div>
        </div>
        {bookError && <div style={styles.warnText}>{bookError}</div>}
        <button
          disabled={lane === null || start === null || booking}
          onClick={confirm}
          style={{
            ...styles.primaryBtn,
            ...(lane === null || start === null || booking ? styles.primaryBtnDisabled : {}),
          }}
        >
          {booking ? "予約処理中..." : "この内容で予約する"}
        </button>
      </Section>
    </div>
  );
}

function Section({ num, title, children, disabled }) {
  return (
    <div style={{ ...styles.section, ...(disabled ? styles.sectionDisabled : {}) }}>
      <div style={styles.sectionHead}>
        <span style={styles.sectionNum}>{num}</span>
        <span style={styles.sectionTitle}>{title}</span>
      </div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

/* ---------------- スタッフエリア（ログインゲート） ---------------- */
function StaffArea({ stores, sessionReady, profileReady, session, staffProfile, logout, refreshStores }) {
  if (!sessionReady) {
    return <div style={styles.centerLoading}>読み込み中...</div>;
  }
  if (!session) {
    return <StaffAuth />;
  }
  if (!profileReady) {
    return <div style={styles.centerLoading}>プロフィールを読み込み中...</div>;
  }
  if (!staffProfile) {
    return (
      <div style={styles.authWrap}>
        <div style={styles.authCard}>
          <div style={styles.authBody}>
            <div style={styles.helperText}>
              このアカウントにはスタッフ権限が設定されていません。管理者にお問い合わせください。
            </div>
            <button style={{ ...styles.secondaryBtn, marginTop: 12 }} onClick={logout}>
              ログアウト
            </button>
          </div>
        </div>
      </div>
    );
  }
  const store = stores.find((s) => s.id === staffProfile.store_id);
  if (!store) {
    return <div style={styles.centerLoading}>担当店舗の情報が見つかりません。管理者にお問い合わせください。</div>;
  }

  return <StaffDashboard store={store} staffProfile={staffProfile} logout={logout} refreshStores={refreshStores} />;
}

function StaffAuth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  async function submit() {
    if (!email || !password) return;
    setAuthError("");
    setSubmitting(true);
    try {
      await signInWithPassword({ email, password });
    } catch (err) {
      setAuthError(errorMessage(err, "メールアドレスまたはパスワードが正しくありません"));
    } finally {
      setSubmitting(false);
    }
  }

  if (forgotMode) {
    return <ForgotPasswordPanel onBack={() => setForgotMode(false)} />;
  }

  return (
    <div style={styles.authWrap}>
      <div style={styles.authCard}>
        <div style={styles.authTabGroup}>
          <div style={{ ...styles.authTab, ...styles.authTabActive }}>スタッフログイン</div>
        </div>
        <div style={styles.authBody}>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Mail size={14} /> メールアドレス
            </label>
            <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="staff@example.com" />
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Lock size={14} /> パスワード
            </label>
            <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="パスワード" />
          </div>
          {authError && <div style={styles.warnText}>{authError}</div>}
          <button style={{ ...styles.primaryBtn, ...(submitting ? styles.primaryBtnDisabled : {}) }} onClick={submit} disabled={submitting}>
            {submitting ? "処理中..." : "ログイン"}
          </button>
          <div style={styles.authHint}>
            <button onClick={() => setForgotMode(true)} style={styles.linkBtn}>
              パスワードをお忘れですか？
            </button>
          </div>
          <div style={styles.authHint}>スタッフアカウントは管理者による招待制です</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- パスワード再設定 ---------------- */
function ForgotPasswordPanel({ onBack }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!email) return;
    setError("");
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, "送信に失敗しました"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.authWrap}>
      <div style={styles.authCard}>
        <div style={styles.authBody}>
          {sent ? (
            <>
              <div style={styles.successIconWrap}>
                <Check size={28} color="#fff" />
              </div>
              <h2 style={styles.successTitle}>再設定メールを送信しました</h2>
              <div style={styles.helperText}>
                {email} 宛にパスワード再設定用のメールを送信しました。メール内のリンクを開いて新しいパスワードを設定してください。
              </div>
              <button style={{ ...styles.secondaryBtn, marginTop: 12 }} onClick={onBack}>
                ログイン画面に戻る
              </button>
            </>
          ) : (
            <>
              <div style={styles.formRow}>
                <label style={styles.formLabel}>
                  <Mail size={14} /> メールアドレス
                </label>
                <input style={styles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              {error && <div style={styles.warnText}>{error}</div>}
              <button
                disabled={submitting}
                style={{ ...styles.primaryBtn, ...(submitting ? styles.primaryBtnDisabled : {}) }}
                onClick={submit}
              >
                {submitting ? "送信中..." : "再設定メールを送る"}
              </button>
              <button style={{ ...styles.secondaryBtn, marginTop: 8 }} onClick={onBack}>
                ログイン画面に戻る
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PasswordRecoveryScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setError("");
    if (password.length < 8) {
      setError("パスワードは8文字以上で入力してください");
      return;
    }
    if (password !== password2) {
      setError("パスワードが一致しません");
      return;
    }
    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, "パスワードの変更に失敗しました"));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div style={styles.authWrap}>
        <div style={styles.authCard}>
          <div style={styles.authBody}>
            <div style={styles.successIconWrap}>
              <Check size={28} color="#fff" />
            </div>
            <h2 style={styles.successTitle}>パスワードを変更しました</h2>
            <button style={styles.primaryBtn} onClick={onDone}>
              はじめる
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.authWrap}>
      <div style={styles.authCard}>
        <div style={styles.authTabGroup}>
          <div style={{ ...styles.authTab, ...styles.authTabActive }}>新しいパスワードを設定</div>
        </div>
        <div style={styles.authBody}>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Lock size={14} /> 新しいパスワード
            </label>
            <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8文字以上" />
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Lock size={14} /> 新しいパスワード（確認）
            </label>
            <input style={styles.input} type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="もう一度入力" />
          </div>
          {error && <div style={styles.warnText}>{error}</div>}
          <button
            disabled={submitting}
            style={{ ...styles.primaryBtn, ...(submitting ? styles.primaryBtnDisabled : {}) }}
            onClick={submit}
          >
            {submitting ? "変更中..." : "パスワードを変更する"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- スタッフ管理画面 ---------------- */
const ROW_H = 16;

function StaffDashboard({ store, staffProfile, logout, refreshStores }) {
  const days = useMemo(() => next10Days(), []);
  const [date, setDate] = useState(toDateStr(days[0]));
  const [modal, setModal] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadReservations = useCallback(() => {
    setLoading(true);
    fetchStaffReservations(store.id, date)
      .then(setReservations)
      .catch((err) => setLoadError(errorMessage(err, "予約の取得に失敗しました")))
      .finally(() => setLoading(false));
  }, [store.id, date]);

  useEffect(() => {
    loadReservations();
  }, [loadReservations]);

  useReservationsRealtime(store.id, loadReservations);

  function openNew(lane, start) {
    setModal({ mode: "new", lane, start, duration: 60, name: "", phone: "" });
  }
  function openEdit(res) {
    setModal({ mode: "edit", lane: res.lane, start: res.start, duration: res.duration, name: res.name, phone: res.phone, id: res.id });
  }

  async function handleSave(data) {
    try {
      if (modal.mode === "new") {
        await staffCreateReservation({ storeId: store.id, lane: modal.lane, date, start: modal.start, ...data });
      } else {
        await staffUpdateReservation(modal.id, data);
      }
      setModal(null);
      loadReservations();
    } catch (err) {
      alert(errorMessage(err, "保存に失敗しました"));
    }
  }

  async function handleDelete() {
    try {
      await staffCancelReservation(modal.id);
      setModal(null);
      loadReservations();
    } catch (err) {
      alert(errorMessage(err, "取消に失敗しました"));
    }
  }

  return (
    <div style={styles.staffWrap}>
      <div style={styles.staffHeader}>
        <div style={styles.dayRow}>
          {days.map((d) => {
            const ds = toDateStr(d);
            const active = ds === date;
            return (
              <button key={ds} onClick={() => setDate(ds)} style={{ ...styles.dayChip, ...(active ? styles.dayChipActive : {}) }}>
                <div style={styles.dayChipWeekday}>{WEEKDAY_JP[d.getDay()]}</div>
                <div style={styles.dayChipNum}>{d.getDate()}</div>
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={styles.legendRow}>
            <LegendDot color="#2F6B4F" label="Web予約" />
            <LegendDot color="#B33A3A" label="電話予約" />
            <LegendDot color="#8A6D2F" label="店頭登録" />
          </div>
          <div style={styles.staffWho}>{staffProfile.name} さん</div>
          <button onClick={() => setSettingsOpen(true)} style={styles.userBarTab}>
            店舗設定
          </button>
          <button onClick={logout} style={styles.userBarLogout}>
            ログアウト
          </button>
        </div>
      </div>

      {loadError && <div style={styles.warnText}>{loadError}</div>}

      {loading ? (
        <div style={styles.section}>読み込み中...</div>
      ) : (
        <div style={styles.gridOuterV}>
          <div style={{ display: "flex" }}>
            <div style={styles.timeAxisCol}>
              <div style={styles.timeAxisCorner} />
              {Array.from({ length: slotCount(store) }, (_, i) => {
                const t = store.openMin + i * SLOT_MIN;
                const isHour = t % 60 === 0;
                return (
                  <div key={i} style={{ ...styles.timeAxisRow, ...(isHour ? styles.timeAxisRowHour : {}) }}>
                    {isHour ? minToTime(t) : ""}
                  </div>
                );
              })}
            </div>

            {Array.from({ length: store.lanes }, (_, laneIdx) => (
              <LaneColumn
                key={laneIdx}
                store={store}
                laneIdx={laneIdx}
                reservations={reservations.filter((r) => r.lane === laneIdx)}
                onEmptyClick={(start) => openNew(laneIdx, start)}
                onResClick={(res) => openEdit(res)}
              />
            ))}
          </div>
        </div>
      )}

      {modal && (
        <ReservationModal
          modal={modal}
          store={store}
          reservations={reservations}
          onClose={() => setModal(null)}
          onSave={handleSave}
          onDelete={modal.mode === "edit" ? handleDelete : null}
          date={date}
        />
      )}

      {settingsOpen && (
        <StoreSettingsModal
          store={store}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            refreshStores();
          }}
        />
      )}
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div style={styles.legendItem}>
      <span style={{ ...styles.legendDot, background: color }} />
      <span style={styles.legendLabel}>{label}</span>
    </div>
  );
}

function LaneColumn({ store, laneIdx, reservations, onEmptyClick, onResClick }) {
  const totalH = slotCount(store) * ROW_H;
  return (
    <div style={styles.laneCol}>
      <div style={styles.laneColHeader}>
        <div style={styles.laneColHeaderNum}>{laneIdx + 1}</div>
        <div style={styles.laneColHeaderText}>番線</div>
      </div>
      <div style={{ ...styles.laneColTrack, height: totalH }}>
        {Array.from({ length: slotCount(store) }, (_, i) => {
          const t = store.openMin + i * SLOT_MIN;
          return (
            <div
              key={i}
              onClick={() => onEmptyClick(t)}
              style={{
                ...styles.slotCellV,
                top: i * ROW_H,
                height: ROW_H,
                borderTop: t % 60 === 0 ? "1px solid #D8D2C2" : "1px solid #EDE9DD",
              }}
            />
          );
        })}
        {reservations.map((r) => {
          const top = ((r.start - store.openMin) / SLOT_MIN) * ROW_H;
          const height = (r.duration / SLOT_MIN) * ROW_H;
          const color = r.source === "web" ? "#2F6B4F" : r.source === "phone" ? "#B33A3A" : "#8A6D2F";
          return (
            <div
              key={r.id}
              onClick={(e) => {
                e.stopPropagation();
                onResClick(r);
              }}
              style={{ ...styles.resBlockV, top, height, background: color }}
              title={`${r.name} ${minToTime(r.start)}-${minToTime(r.start + r.duration)}`}
            >
              <span style={styles.resBlockTextV}>{r.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReservationModal({ modal, store, reservations, onClose, onSave, onDelete, date }) {
  const [duration, setDuration] = useState(modal.duration || 60);
  const [name, setName] = useState(modal.name || "");
  const [phone, setPhone] = useState(modal.phone || "");
  const [start, setStart] = useState(modal.start);
  const [saving, setSaving] = useState(false);

  const starts = availableStarts(store, reservations, modal.lane, date, duration).concat(
    modal.mode === "edit" ? [modal.start] : []
  );
  const uniqueStarts = [...new Set(starts)].sort((a, b) => a - b);
  const free = isFree(store, reservations, modal.lane, date, start, duration, modal.mode === "edit" ? modal.id : undefined);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ start, duration, name, phone });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <div>
            <div style={styles.modalTitle}>{modal.mode === "new" ? "予約を登録" : "予約を編集"}</div>
            <div style={styles.modalSub}>
              {modal.lane + 1}番線 ・ {formatDateJp(date)}
            </div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}>
            <X size={18} />
          </button>
        </div>

        <div style={styles.modalBody}>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Clock size={14} /> 開始時刻
            </label>
            <select style={styles.input} value={start} onChange={(e) => setStart(Number(e.target.value))}>
              {uniqueStarts.map((t) => (
                <option key={t} value={t}>
                  {minToTime(t)}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>利用時間</label>
            <div style={styles.durationRow}>
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDuration(d)}
                  style={{ ...styles.durationChip, ...(duration === d ? styles.durationChipActive : {}) }}
                >
                  {d}分
                </button>
              ))}
            </div>
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <User size={14} /> お名前
            </label>
            <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 太郎様" />
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              <Phone size={14} /> 電話番号
            </label>
            <input style={styles.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="090-1234-5678" />
          </div>
          {!free && <div style={styles.warnText}>この時間帯は既に予約が入っています</div>}
        </div>

        <div style={styles.modalFoot}>
          {onDelete && (
            <button onClick={onDelete} style={styles.dangerBtn}>
              予約を取消
            </button>
          )}
          <button
            disabled={!name || !phone || !free || saving}
            onClick={handleSave}
            style={{ ...styles.primaryBtn, ...((!name || !phone || !free || saving) ? styles.primaryBtnDisabled : {}) }}
          >
            {saving ? "保存中..." : "保存する"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StoreSettingsModal({ store, onClose, onSaved }) {
  const [laneCount, setLaneCount] = useState(store.lanes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    if (!Number.isInteger(laneCount) || laneCount < 1) {
      setError("番線数は1以上の整数で入力してください");
      return;
    }
    setSaving(true);
    try {
      if (laneCount < store.lanes) {
        const overflow = await countReservationsBeyondLane(store.id, laneCount);
        if (overflow > 0) {
          setError(
            `${laneCount + 1}番線以降に今日以降の予約が${overflow}件あるため、この番線数には変更できません。先にそれらの予約を移動・キャンセルしてください。`
          );
          setSaving(false);
          return;
        }
      }
      await updateStoreLaneCount(store.id, laneCount);
      onSaved();
    } catch (err) {
      setError("保存に失敗しました。管理者にお問い合わせください。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <div>
            <div style={styles.modalTitle}>店舗設定</div>
            <div style={styles.modalSub}>{store.name}</div>
          </div>
          <button onClick={onClose} style={styles.iconBtn}>
            <X size={18} />
          </button>
        </div>

        <div style={styles.modalBody}>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>番線数</label>
            <input
              type="number"
              min={1}
              style={styles.input}
              value={laneCount}
              onChange={(e) => setLaneCount(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          {error && <div style={styles.warnText}>{error}</div>}
        </div>

        <div style={styles.modalFoot}>
          <button
            disabled={saving}
            onClick={handleSave}
            style={{ ...styles.primaryBtn, ...(saving ? styles.primaryBtnDisabled : {}) }}
          >
            {saving ? "保存中..." : "保存する"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   スタイル定義
   ============================================================ */
const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
`;

const NAVY_950 = "#10182B";
const NAVY_800 = "#1D2A44";
const CREAM = "#FAF7F0";
const PAPER = "#FFFFFF";
const AMBER = "#E8A33D";
const LINE = "#E4DFD3";
const INK = "#2B2D36";
const INK_SOFT = "#6B6E78";

const styles = {
  appRoot: {
    fontFamily: "'Inter', sans-serif",
    background: CREAM,
    color: INK,
    minHeight: "100%",
    width: "100%",
  },
  body: { padding: "20px 20px 60px" },
  centerLoading: { padding: 60, textAlign: "center", color: INK_SOFT, fontSize: 14 },

  topbar: {
    background: NAVY_950,
    padding: "14px 20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
    borderBottom: `3px solid ${AMBER}`,
  },
  topbarLeft: { display: "flex", alignItems: "center", gap: 10 },
  brandMark: {
    width: 34, height: 34, borderRadius: 8, background: NAVY_800,
    display: "flex", alignItems: "center", justifyContent: "center",
    border: `1px solid rgba(232,163,61,0.4)`,
  },
  brandTitle: { color: "#fff", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: 0.2 },
  brandSub: { color: "#8B93A8", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, letterSpacing: 1.2, marginTop: 2 },
  topbarRight: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  storeSelect: {
    background: NAVY_800, color: "#fff", border: "1px solid #2E3B5C", borderRadius: 6,
    padding: "8px 10px", fontSize: 13, fontFamily: "'Inter', sans-serif", fontWeight: 500,
  },
  storeLockedLabel: {
    background: NAVY_800, color: AMBER, border: "1px solid #2E3B5C", borderRadius: 6,
    padding: "8px 10px", fontSize: 13, fontFamily: "'Inter', sans-serif", fontWeight: 600,
  },
  tabGroup: { display: "flex", background: NAVY_800, borderRadius: 8, padding: 3, gap: 2 },
  tabBtn: {
    border: "none", background: "transparent", color: "#8B93A8", padding: "7px 14px",
    borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "'Inter', sans-serif",
  },
  tabBtnActive: { background: AMBER, color: NAVY_950 },

  customerWrap: { maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 },
  customerSteps: { display: "flex", flexDirection: "column", gap: 14 },

  authWrap: { maxWidth: 420, margin: "40px auto" },
  authCard: { background: PAPER, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden" },
  authTabGroup: { display: "flex", borderBottom: `1px solid ${LINE}` },
  authTab: {
    flex: 1, border: "none", background: "transparent", padding: "13px 0", fontSize: 13.5,
    fontWeight: 600, color: INK_SOFT, cursor: "pointer", fontFamily: "'Inter', sans-serif", textAlign: "center",
  },
  authTabActive: { color: NAVY_950, boxShadow: `inset 0 -2px 0 ${AMBER}` },
  authBody: { padding: "20px 22px" },
  authHint: { marginTop: 12, fontSize: 11.5, color: INK_SOFT, textAlign: "center" },
  linkBtn: {
    border: "none", background: "transparent", color: NAVY_950, fontSize: 12,
    textDecoration: "underline", cursor: "pointer", padding: 0, fontFamily: "'Inter', sans-serif",
  },

  userBar: {
    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10,
    background: PAPER, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 14px",
  },
  userBarLeft: { display: "flex", alignItems: "center", gap: 10 },
  userAvatar: {
    width: 32, height: 32, borderRadius: "50%", background: NAVY_950, color: AMBER,
    display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  userBarName: { fontSize: 13, fontWeight: 700 },
  userBarEmail: { fontSize: 11, color: INK_SOFT },
  userBarRight: { display: "flex", alignItems: "center", gap: 6 },
  userBarTab: {
    border: `1px solid ${LINE}`, background: PAPER, borderRadius: 6, padding: "6px 12px",
    fontSize: 12, fontWeight: 600, cursor: "pointer",
  },
  userBarTabActive: { background: NAVY_950, color: "#fff", borderColor: NAVY_950 },
  userBarLogout: { border: "none", background: "transparent", color: INK_SOFT, fontSize: 12, cursor: "pointer", padding: "6px 4px" },

  myResCard: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
    background: PAPER, border: `1px solid ${LINE}`, borderRadius: 10, padding: "14px 16px",
  },
  myResStore: { fontSize: 13, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" },
  myResDetail: { fontSize: 12.5, color: INK_SOFT, marginTop: 3, fontFamily: "'IBM Plex Mono', monospace" },

  confirmProfile: { border: `1px solid ${LINE}`, borderRadius: 8, padding: "12px 14px", marginBottom: 12, display: "flex", flexDirection: "column", gap: 6 },
  confirmProfileRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 },

  secondaryBtn: {
    background: "transparent", color: NAVY_950, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 18px",
    fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%", marginTop: 8,
  },

  section: {
    background: PAPER, border: `1px solid ${LINE}`, borderRadius: 10, padding: "16px 18px",
    transition: "opacity 0.15s",
  },
  sectionDisabled: { opacity: 0.45, pointerEvents: "none" },
  sectionHead: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 },
  sectionNum: { fontFamily: "'IBM Plex Mono', monospace", color: AMBER, fontWeight: 600, fontSize: 12.5 },
  sectionTitle: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15, color: INK },
  sectionBody: {},

  dayRow: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 },
  dayChip: {
    minWidth: 52, border: `1px solid ${LINE}`, background: PAPER, borderRadius: 8,
    padding: "8px 4px", cursor: "pointer", textAlign: "center", flexShrink: 0,
  },
  dayChipActive: { background: NAVY_950, borderColor: NAVY_950 },
  dayChipWeekday: { fontSize: 10.5, color: INK_SOFT, fontFamily: "'IBM Plex Mono', monospace" },
  dayChipNum: { fontSize: 17, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif", color: INK },

  laneGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 8 },
  laneCard: {
    border: `1px solid ${LINE}`, background: PAPER, borderRadius: 8, padding: "10px 4px",
    cursor: "pointer", textAlign: "center",
  },
  laneCardActive: { background: "#EFDDB8", borderColor: AMBER },
  laneCardFull: { opacity: 0.35, cursor: "not-allowed" },
  laneCardNum: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 16 },
  laneCardSuffix: { fontSize: 11, fontWeight: 600, marginLeft: 2 },
  laneCardLabel: { fontSize: 9.5, color: INK_SOFT, marginTop: 2 },

  durationRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  durationChip: {
    border: `1px solid ${LINE}`, background: PAPER, borderRadius: 20, padding: "7px 16px",
    fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Inter', sans-serif",
  },
  durationChipActive: { background: NAVY_950, color: "#fff", borderColor: NAVY_950 },

  timeGridWrap: { display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" },
  timeChip: {
    border: `1px solid ${LINE}`, background: PAPER, borderRadius: 6, padding: "6px 10px",
    fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer", fontWeight: 500,
  },
  timeChipActive: { background: AMBER, borderColor: AMBER, color: NAVY_950, fontWeight: 700 },
  helperText: { color: INK_SOFT, fontSize: 13 },

  mapCard: { background: NAVY_950, borderRadius: 10, padding: "14px 16px", color: "#fff" },
  mapHead: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  mapTitle: { display: "flex", alignItems: "center", gap: 7, fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 12.5, color: "#fff" },
  mapScrollV: { overflowX: "auto", maxHeight: 260, overflowY: "auto", paddingBottom: 4 },
  mapTimeAxis: { flexShrink: 0, width: 34, position: "sticky", left: 0, background: NAVY_950, zIndex: 2 },
  mapCornerSm: { height: 20, position: "sticky", top: 0, background: NAVY_950, zIndex: 3 },
  mapTimeRowLabel: {
    fontSize: 8, color: "#8B93A8", fontFamily: "'IBM Plex Mono', monospace", textAlign: "right",
    paddingRight: 4, lineHeight: `${MAP_ROW_H}px`,
  },
  mapCol: { flexShrink: 0, width: MAP_COL_W, borderLeft: "1px solid #2E3B5C" },
  mapColHeaderSm: {
    height: 20, display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 10, fontWeight: 600, color: "#C9CEDA", fontFamily: "'IBM Plex Mono', monospace",
    position: "sticky", top: 0, background: NAVY_950, zIndex: 2,
  },
  mapLabelActive: { color: AMBER },
  mapColTrack: { position: "relative", background: "#1D2A44" },
  mapBusyBlockV: { position: "absolute", left: 1, right: 1, background: "#B33A3A", borderRadius: 2 },
  mapSelectedBlockV: {
    position: "absolute", left: -1, right: -1, background: "rgba(232,163,61,0.35)",
    border: `1.5px solid ${AMBER}`, borderRadius: 3, boxSizing: "border-box",
  },

  formRow: { display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 },
  formLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: INK_SOFT },
  input: {
    border: `1px solid ${LINE}`, borderRadius: 6, padding: "9px 10px", fontSize: 14,
    fontFamily: "'Inter', sans-serif", background: PAPER, color: INK,
  },

  primaryBtn: {
    background: NAVY_950, color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px",
    fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif",
    width: "100%", marginTop: 4,
  },
  primaryBtnDisabled: { background: "#C7C2B5", cursor: "not-allowed" },
  dangerBtn: {
    background: "transparent", color: "#B33A3A", border: "1px solid #B33A3A", borderRadius: 8,
    padding: "10px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  },

  successIconWrap: {
    width: 52, height: 52, borderRadius: "50%", background: "#2F6B4F",
    display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px",
  },
  successTitle: { textAlign: "center", fontFamily: "'Space Grotesk', sans-serif", fontSize: 19, marginBottom: 18 },
  stepCard: { maxWidth: 480, margin: "40px auto", background: PAPER, border: `1px solid ${LINE}`, borderRadius: 12, padding: 28 },
  ticket: { border: `1px dashed ${LINE}`, borderRadius: 8, padding: 16, marginBottom: 18 },
  ticketRow: { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${LINE}` },
  ticketLabel: { fontSize: 12, color: INK_SOFT },
  ticketValue: { fontSize: 13.5, fontWeight: 600 },
  ticketValueMono: { fontSize: 13.5, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" },

  staffWrap: { maxWidth: 1180, margin: "0 auto" },
  staffHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 14 },
  staffWho: { fontSize: 12.5, color: INK_SOFT, fontWeight: 600 },
  legendRow: { display: "flex", gap: 14 },
  legendItem: { display: "flex", alignItems: "center", gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 2 },
  legendLabel: { fontSize: 11.5, color: INK_SOFT },

  gridOuterV: { background: PAPER, border: `1px solid ${LINE}`, borderRadius: 10, overflow: "auto", padding: "12px", maxHeight: 620 },

  timeAxisCol: { flexShrink: 0, width: 46, position: "sticky", left: 0, background: PAPER, zIndex: 3 },
  timeAxisCorner: { height: 36, borderBottom: `1px solid ${LINE}`, position: "sticky", top: 0, background: PAPER, zIndex: 4 },
  timeAxisRow: {
    height: ROW_H, fontSize: 9, color: "transparent", fontFamily: "'IBM Plex Mono', monospace",
    textAlign: "right", paddingRight: 6, lineHeight: `${ROW_H}px`,
  },
  timeAxisRowHour: { color: INK_SOFT, fontWeight: 600 },

  laneCol: { flexShrink: 0, width: 46, borderLeft: `1px solid ${LINE}` },
  laneColHeader: {
    height: 36, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    borderBottom: `1px solid ${LINE}`, background: "#FBF9F4", position: "sticky", top: 0, zIndex: 2,
  },
  laneColHeaderNum: { fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14 },
  laneColHeaderText: { fontSize: 7.5, color: INK_SOFT, letterSpacing: 1 },
  laneColTrack: { position: "relative" },
  slotCellV: { position: "absolute", left: 0, right: 0, cursor: "pointer" },
  resBlockV: {
    position: "absolute", left: 2, right: 2, borderRadius: 4, display: "flex", alignItems: "center",
    justifyContent: "center", padding: "1px 2px", cursor: "pointer", overflow: "hidden",
    boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
  },
  resBlockTextV: { color: "#fff", fontSize: 9, fontWeight: 600, textAlign: "center", lineHeight: 1.2, wordBreak: "break-all" },

  modalOverlay: {
    position: "fixed", inset: 0, background: "rgba(16,24,43,0.55)", display: "flex",
    alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16,
  },
  modalCard: { background: PAPER, borderRadius: 12, width: 380, maxWidth: "100%", overflow: "hidden" },
  modalHead: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    padding: "16px 18px", borderBottom: `1px solid ${LINE}`, background: NAVY_950,
  },
  modalTitle: { color: "#fff", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15 },
  modalSub: { color: "#8B93A8", fontSize: 11.5, marginTop: 3, fontFamily: "'IBM Plex Mono', monospace" },
  iconBtn: { background: "transparent", border: "none", color: "#8B93A8", cursor: "pointer" },
  modalBody: { padding: "16px 18px" },
  modalFoot: { display: "flex", gap: 10, padding: "0 18px 18px", justifyContent: "flex-end", alignItems: "center" },
  warnText: { color: "#B33A3A", fontSize: 12, marginTop: -4 },
};
