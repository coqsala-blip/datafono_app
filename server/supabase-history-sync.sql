-- =====================================================================================
-- SINCRONIZAR HISTORIAL: PASO 1 de 2  (OBLIGATORIO)
-- Ejecuta TODO este bloque primero, en Supabase -> SQL Editor -> Run.
-- Es idempotente (se puede repetir sin romper nada) y va en transaccion: si algo falla,
-- no se aplica nada a medias.
--
-- Debe ejecutarse en el MISMO proyecto Supabase que usa el backend. El backend de la app
-- apunta a: https://ngoosxacgtrpwnjqwxkr.supabase.co
-- Comprueba que la URL del Dashboard contiene "ngoosxacgtrpwnjqwxkr".
-- =====================================================================================

begin;

-- 1) documents.user_id: vincula cada ticket/factura con la cuenta que lo emite.
alter table public.documents
  add column if not exists user_id uuid references auth.users (id) on delete set null;

-- 2) documents.updated_at: la usa el listado de documentos del backend.
alter table public.documents
  add column if not exists updated_at timestamptz not null default now();

create index if not exists documents_user_id_created_at_idx
  on public.documents (user_id, created_at desc);

-- 3) Permisos para el backend (usa la clave secreta = rol service_role).
--    Sin esto Supabase responde 42501 "permission denied for table expenses".
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

commit;

-- Comprobacion (debe devolver 3 columnas y counts): si sale error 42703, no se ejecuto el bloque.
select column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'documents'
   and column_name in ('user_id', 'updated_at', 'created_at')
 order by column_name;


-- =====================================================================================
-- SINCRONIZAR HISTORIAL: PASO 2 de 2  (opcional, para recuperar los tickets ANTIGUOS)
-- Los 282 documentos que ya estan en la nube se emitieron SIN sesion (user_id vacio).
-- Ejecuta este UPDATE DESPUES del PASO 1, en el mismo proyecto, cambiando el email por
-- el de la cuenta con la que entras en la app (hay dos: hichamfilali1982@gmail.com y
-- coqsala32@gmail.com). Si no quieres adoptarlos, no ejecutes nada aqui.
-- =====================================================================================

-- update public.documents
--    set user_id = (select id from auth.users where email = 'hichamfilali1982@gmail.com')
--  where user_id is null;

-- Ver cuantos documentos quedan sin dueño (total ahora mismo: 282):
-- select count(*) as total,
--        count(*) filter (where user_id is null) as sin_dueno,
--        count(*) filter (where user_id is not null) as con_dueno
--   from public.documents;

