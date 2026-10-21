-- 0010: Restore the Furtuna Skin brand in the public settings.
-- A demo configuration left "BYOMA" behind in brand_name — which every page
-- header (brand name) and footer (copyright line) renders — and pointed the
-- shop link at another store. Only those wrong values are corrected: a brand
-- name an administrator chose deliberately is never clobbered, mirroring the
-- guarded updates in 0008 and 0009. The column default is aligned too so a
-- fresh install seeds the correct spelling.

alter table public.application_settings
  alter column brand_name set default 'Furtuna Skin';

update public.application_settings
set brand_name = 'Furtuna Skin',
    updated_at = now()
where upper(brand_name) = 'BYOMA'
   or brand_name = 'Fortuna Skin';

update public.application_settings
set shop_url = 'https://www.furtunaskin.com/collections/all',
    updated_at = now()
where lower(shop_url) like '%byoma.com%';
