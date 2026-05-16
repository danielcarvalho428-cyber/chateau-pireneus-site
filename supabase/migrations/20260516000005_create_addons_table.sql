-- Configurable add-ons for the booking checkout flow.
-- Admin can toggle each one on/off, set the price, and write a custom description.

create table if not exists addons (
  id          text primary key,
  label       text          not null,
  description text          not null default '',
  price       numeric(10,2) not null,
  per         text          not null check (per in ('flat', 'person_night')),
  active      boolean       not null default false,
  updated_at  timestamptz   not null default now()
);

-- Seed with the two current add-ons (breakfast inactive by default)
insert into addons (id, label, description, price, per, active) values
  ('breakfast',   'Café da manhã',    'Servido às 9h no espaço comum da pousada.', 45,  'person_night', false),
  ('welcome_kit', 'Kit boas-vindas',  'Espumante + frutas frescos na suíte na chegada.', 150, 'flat', true)
on conflict (id) do nothing;

-- Only admins can write; anyone authenticated can read active add-ons
alter table addons enable row level security;

create policy "addons_read" on addons
  for select using (true);

create policy "addons_admin_write" on addons
  for all using (is_current_user_admin())
  with check (is_current_user_admin());
