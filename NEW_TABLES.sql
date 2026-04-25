-- ══════════════════════════════════════════════════════
--  SDT SYSTEM — NEW TABLES SQL
--  Run this in Supabase SQL Editor
-- ══════════════════════════════════════════════════════

-- 1. PRESS RECORDS TABLE
create table if not exists press_records (
  id text primary key,
  date text,
  worker_id text,
  worker_name text,
  sku text,
  item_description text,
  category text,
  qty integer,
  remarks text,
  encoded_by text,
  ts timestamptz default now()
);
alter table press_records enable row level security;
create policy "public_all" on press_records for all using (true) with check (true);

-- 2. UPDATE PRINTING RECORDS TABLE (add new columns if not exist)
alter table printing_records add column if not exists sku text;
alter table printing_records add column if not exists item_description text;
alter table printing_records add column if not exists category text;

-- 3. SKU MASTER TABLE (optional - for server-side lookup)
create table if not exists sku_master (
  sku text primary key,
  item_description text,
  category text
);
alter table sku_master enable row level security;
create policy "public_all" on sku_master for all using (true) with check (true);

-- ══════════════════════════════════════════════════════
--  DONE — Run the above SQL in Supabase SQL Editor
-- ══════════════════════════════════════════════════════
