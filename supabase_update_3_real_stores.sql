-- ============================================================
-- 実店舗リストへの入れ替え
-- テスト用の店舗・予約・スタッフ権限を削除してから、
-- 実際の47店舗（南船橋店を除く）を登録します
-- ============================================================

delete from reservations;
delete from staff_profiles;
delete from stores;

insert into stores (id, name, lane_count, open_min, close_min) values
  ('01_sapporo_odori', '札幌大通店', 14, 600, 1260),
  ('02_aeon_natori', 'イオンモール名取店', 12, 600, 1260),
  ('03_akihabara', '秋葉原店', 12, 600, 1230),
  ('04_akiba_reuse', 'あきばリユース店', 4, 660, 1200),
  ('05_keio_shinjuku', '京王百貨店新宿店', 8, 600, 1200),
  ('06_asakusa_ekimise', 'ポポンデッタwith 東武鉄道ギャラリー（浅草エキミセ店）', 12, 600, 1200),
  ('07_cereo_hachioji', 'セレオ八王子店', 12, 600, 1200),
  ('08_ariake_garden', '有明ガーデン店', 14, 600, 1260),
  ('09_yokohama_nishiguchi', '横浜西口店', 12, 570, 1200),
  ('10_tressa_yokohama', 'トレッサ横浜店', 14, 600, 1200),
  ('11_seibu_higashitotsuka', '西武東戸塚店', 6, 600, 1200),
  ('12_ebina', 'ポポンデッタwith 小田急トレインギャラリー（海老名店）', 8, 600, 1260),
  ('13_kawasaki_azalea', '川崎アゼリア店', 14, 600, 1260),
  ('14_grantree_musashikosugi', 'グランツリー武蔵小杉店', 12, 600, 1260),
  ('15_ario_hashimoto', 'アリオ橋本店', 8, 600, 1260),
  ('16_globo_soga', 'ＧＬＯＢＯ蘇我店', 10, 600, 1200),
  ('17_aeon_makuhari', 'イオンモール幕張新都心店', 14, 600, 1260),
  ('18_sevenpark_ario_kashiwa', 'セブンパークアリオ柏店', 14, 600, 1260),
  ('19_laragarden_kawaguchi', 'ララガーデン川口店', 14, 600, 1200),
  ('20_aeon_kawaguchi', 'イオンモール川口店', 14, 600, 1260),
  ('21_koshigaya_laketown', '越谷レイクタウン店', 14, 600, 1260),
  ('22_tokotoko_tokorozawa', 'トコトコスクエア所沢店', 12, 600, 1200),
  ('23_aeon_hanyu', 'イオンモール羽生店', 14, 600, 1260),
  ('24_lalaport_fujimi', 'ららぽーと富士見店', 12, 600, 1200),
  ('25_aeon_tsukuba', 'イオンモールつくば店', 14, 600, 1260),
  ('26_aeon_mito_uchihara', 'イオンモール水戸内原店', 12, 600, 1260),
  ('27_aeon_takasaki', 'イオンモール高崎店', 14, 600, 1260),
  ('28_aeon_matsumoto', 'イオンモール松本店', 8, 600, 1260),
  ('29_shizuoka_parche', 'ポポンデッタwith 東海道線ギャラリー（静岡パルシェ店）', 8, 600, 1200),
  ('30_aeon_hamamatsu_ichino', 'イオンモール浜松市野店', 14, 600, 1260),
  ('31_colorfultown_gifu', 'カラフルタウン岐阜店', 14, 600, 1260),
  ('32_aeon_toki', 'イオンモール土岐店', 13, 600, 1200),
  ('33_nagoya_osu', '名古屋大須店', 6, 600, 1200),
  ('34_kanazawa_forus', '金沢フォーラス店', 14, 600, 1200),
  ('35_aeon_toin', 'イオンモール東員店', 14, 600, 1200),
  ('36_osaka_nipponbashi', '大阪日本橋店', 15, 600, 1200),
  ('37_kintetsu_abenoharukas', '近鉄あべのハルカス店', 14, 600, 1200),
  ('38_lalaport_izumi', 'ららぽーと和泉店', 14, 600, 1200),
  ('39_expocity', 'エキスポシティ店', 12, 600, 1200),
  ('40_hankyu_sanbangai', '阪急三番街店', 12, 600, 1260),
  ('41_aeon_kyoto', 'イオンモールKYOTO店', 18, 600, 1260),
  ('42_kobe_harborland_umie', '神戸ハーバーランドumie店', 14, 600, 1200),
  ('43_lalaport_koshien', 'ららぽーと甲子園店', 14, 600, 1200),
  ('44_aeon_okayama', 'イオンモール岡山店', 14, 600, 1260),
  ('45_hiroshima_minamoa', '広島ミナモア店', 12, 600, 1200),
  ('46_amuplaza_hakata', 'アミュプラザ博多店', 12, 600, 1200),
  ('47_aeon_chikushino', 'イオンモール筑紫野店', 14, 600, 1260);
