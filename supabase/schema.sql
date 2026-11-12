-- Plano de Manutenção (VERA ETO) — inspeção da rede MT de Palmas e Taquaralto.
-- Projeto Supabase «LGRSV's Project». Tudo com prefixo pm_ para não misturar com o resto do projeto.
-- Regra: as tabelas são só de acréscimo (append-only). O estado de um poste é a última inspeção dele;
-- o histórico é a tabela inteira. Ninguém apaga nem altera pelo app.

create table if not exists public.pm_inspecoes (
  id          bigint generated always as identity primary key,
  cliente_id  text not null unique check (length(cliente_id) between 8 and 64),  -- gerado no celular: reenvio não duplica
  criado_em   timestamptz not null default now(),
  feito_em    timestamptz,                                  -- hora do celular quando o técnico salvou
  poste       text not null check (length(poste) between 1 and 40),
  quadra      text check (length(quadra) <= 10),
  alimentador text check (length(alimentador) <= 12),
  tecnico     text not null check (length(tecnico) between 2 and 60),
  resultado   text not null check (resultado in ('sem_anomalia', 'anomalia', 'nao_localizado', 'sem_acesso')),
  prioridade  text check (prioridade in ('urgente', '6meses', 'dez2027')),
  itens       jsonb not null default '[]'::jsonb check (jsonb_typeof(itens) = 'array' and pg_column_size(itens) < 20000),
  obs         text check (length(obs) <= 2000),
  lat         double precision,
  lon         double precision,
  precisao_m  real,
  dist_m      real,                                         -- distância do GPS do técnico até o poste
  app_versao  text check (length(app_versao) <= 20)
);
comment on table public.pm_inspecoes is
  'Plano de Manutenção: uma linha por inspeção de estrutura MT. Append-only: o estado do poste é a última linha dele.';
create index if not exists pm_inspecoes_poste on public.pm_inspecoes (poste, criado_em desc);
create index if not exists pm_inspecoes_quadra on public.pm_inspecoes (quadra);
create index if not exists pm_inspecoes_criado on public.pm_inspecoes (criado_em);

create table if not exists public.pm_rotas (
  id        bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  quadra    text not null,
  tecnico   text,          -- vazio = quadra devolvida (sem técnico)
  por       text
);
comment on table public.pm_rotas is
  'Plano de Manutenção: quadra atribuída a técnico. Append-only: vale a última linha da quadra. Só grava pela função pm_atribui (PIN do gestor).';
create index if not exists pm_rotas_quadra on public.pm_rotas (quadra, criado_em desc);

create table if not exists public.pm_senhas (
  chave text primary key,
  hash  text not null
);
comment on table public.pm_senhas is 'Plano de Manutenção: hash bcrypt do PIN do gestor. Sem políticas de RLS: só as funções pm_* leem.';

alter table public.pm_inspecoes enable row level security;
alter table public.pm_rotas enable row level security;
alter table public.pm_senhas enable row level security;

drop policy if exists pm_inspecoes_le on public.pm_inspecoes;
create policy pm_inspecoes_le on public.pm_inspecoes for select to anon, authenticated using (true);
drop policy if exists pm_inspecoes_grava on public.pm_inspecoes;
create policy pm_inspecoes_grava on public.pm_inspecoes for insert to anon, authenticated with check (true);
drop policy if exists pm_rotas_le on public.pm_rotas;
create policy pm_rotas_le on public.pm_rotas for select to anon, authenticated using (true);

-- estado atual: última inspeção de cada poste
create or replace view public.pm_estado with (security_invoker = true) as
  select distinct on (poste) poste, quadra, alimentador, tecnico, resultado, prioridade, criado_em, feito_em, id
  from public.pm_inspecoes
  order by poste, criado_em desc, id desc;

-- rota atual: último técnico de cada quadra
create or replace view public.pm_rota_atual with (security_invoker = true) as
  select distinct on (quadra) quadra, tecnico, por, criado_em
  from public.pm_rotas
  order by quadra, criado_em desc, id desc;

create or replace function public.pm_confere_pin(pin text)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.pm_senhas s
                 where s.chave = 'gestor' and s.hash = extensions.crypt(pm_confere_pin.pin, s.hash));
$$;

create or replace function public.pm_atribui(pin text, quadras text[], tecnico text, por text)
returns integer language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  if not public.pm_confere_pin(pin) then
    raise exception 'PIN do gestor não confere' using errcode = '28000';
  end if;
  if array_length(quadras, 1) is null or array_length(quadras, 1) > 500 then
    raise exception 'lista de quadras vazia ou grande demais';
  end if;
  insert into public.pm_rotas (quadra, tecnico, por)
    select q, nullif(btrim(pm_atribui.tecnico), ''), left(pm_atribui.por, 60) from unnest(quadras) q;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.pm_confere_pin(text) from public;
revoke all on function public.pm_atribui(text, text[], text, text) from public;
grant execute on function public.pm_confere_pin(text) to anon, authenticated;
grant execute on function public.pm_atribui(text, text[], text, text) to anon, authenticated;

-- fotos: bucket privado; o app grava e lê com a chave pública; não sobrescreve nem apaga
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-fotos', 'pm-fotos', false, 1048576, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists pm_fotos_grava on storage.objects;
create policy pm_fotos_grava on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'pm-fotos');
drop policy if exists pm_fotos_le on storage.objects;
create policy pm_fotos_le on storage.objects for select to anon, authenticated
  using (bucket_id = 'pm-fotos');

-- PIN do gestor (definido fora do repositório):
-- insert into public.pm_senhas values ('gestor', extensions.crypt('<PIN>', extensions.gen_salt('bf')))
--   on conflict (chave) do update set hash = excluded.hash;
