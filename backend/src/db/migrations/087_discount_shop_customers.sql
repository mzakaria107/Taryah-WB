-- Migration 087: discount_shop_customers — DB-backed, uploadable customer
-- list for the Discount Shops page, replacing the hardcoded
-- DISCOUNT_SHOP_CODES array in discountShops.js. Seeded with the current
-- 40-customer segment so the page's behavior is unchanged immediately
-- after this migration runs.

CREATE TABLE IF NOT EXISTS discount_shop_customers (
  customer_code VARCHAR(50) PRIMARY KEY,
  customer_name TEXT,
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO discount_shop_customers (customer_code, customer_name) VALUES
  ('12040053','Abd El Salam Abd El Mohsen El Dahy Branch'),
  ('12040055','Abd El Salam Abd El Mohsen Co El Baseria Branch'),
  ('12040056','Abd El Salam Abd El Mohsen Co. El Ufoq Branch'),
  ('12020054','Abd Elsalam Elmohsen Elrahab Co'),
  ('12040054','Abd El Salam Abd El Mohsen Co. El Fakhria Branch'),
  ('12040057','Abd El Salam Abd El Mohsen Co. El Nahda Branch'),
  ('12040058','Abd El Salam Abd El Mohsen Co. El Bashr Branch'),
  ('12040079','Abdelsalam Abdelmohsen Sultana Co.'),
  ('12040084','Abdelsalam Abdelmohsen - Alsoq Branch Co'),
  ('14020077','Zl Altwfer Altagara Co'),
  ('14020081','Makshat Go For Trading El Mahta'),
  ('14020082','Makshat Go For Trading El Madina'),
  ('14020083','Makshat Go For Trading El Masyaf'),
  ('11010029','Basaten Alaaqelat for Trade'),
  ('11030050','Basateen Al-Aqilat Trading Markets 2'),
  ('11030068','Kingdom International Trading Al khaleg Branch'),
  ('11030110','Al Alkef  Dist Tnal Co'),
  ('11030115','Al Alkef Boaba Alsharq'),
  ('11020111','Halwyat City Alghzaia  Co'),
  ('11030116','Mtagr Markt'),
  ('11040086','SuperMarkt Twiq Mkhazn'),
  ('14020061','Aswak Alrashed'),
  ('14050074','Wadhy Abdelhady Alrashedy Co'),
  ('11070068','Asoak & Makhabz Elten Co'),
  ('11050068','Mohamed Rshed Elrasheed Co'),
  ('11080012','Zahra Elragba Altagara Co'),
  ('11090039','Rkn Almzaq Alhlwyat Co'),
  ('11090041','Rokn Mazaq Shop 2'),
  ('11090050','Mkhazn Almamlka Alamia Altgaria'),
  ('11030066','Mhazn Almmlka Alkhleg'),
  ('11100012','Mohamed Rashed El Rashed Company For Trading'),
  ('11100031','Saer El Takhfed For Trading'),
  ('11100032','Saer El Takhfed For Trading 2'),
  ('100196','Basaten el reef Co.'),
  ('15050026','Zil Altawfir Co'),
  ('15040042','Matagr Abyat Altgaria Co'),
  ('15040054','Knoz Altkhfedat'),
  ('15040069','Mzaya Altwfer Almthda Co'),
  ('15060012','Alala Alktsdia'),
  ('15060013','Sda Altwfer Altgara')
ON CONFLICT (customer_code) DO NOTHING;
