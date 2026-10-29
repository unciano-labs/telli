-- Voice Agent tenant registration & cross-site auth isolation
-- Website: "Voice Agent" (c8b2b438-d3d9-4ec9-8493-768a2476241f)

-- 1. Website row (already created via API on 2026-10-29; idempotent for fresh environments)
insert into public.websites (id, user_id, name, theme, status)
select
  'c8b2b438-d3d9-4ec9-8493-768a2476241f'::uuid,
  'c640face-6283-4bbf-923d-a4ceaffcb71b'::uuid,
  'Voice Agent',
  '{}'::jsonb,
  'draft'
where not exists (
  select 1 from public.websites where id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f'::uuid
);

-- 2. Website roles
--    admin: manages agent config & knowledge base (/admin, /api/admin/*)
--    user:  self-registered via the Voice Agent signup page
insert into public.website_roles (website_id, role)
select 'c8b2b438-d3d9-4ec9-8493-768a2476241f'::uuid, r.role
from (values ('admin'), ('user')) as r(role)
where not exists (
  select 1 from public.website_roles wr
  where wr.website_id = 'c8b2b438-d3d9-4ec9-8493-768a2476241f'::uuid
    and wr.role = r.role
);

-- 3. Close cross-site privilege escalation (affects ALL websites)
--    enroll_user_in_website accepts an arbitrary p_user_id and p_role_name, so any
--    authenticated user from any website could grant themselves 'admin' on any
--    other website. Restrict it to the service role (server-side code only).
--    Self-service signup should use register_website_user, which only grants
--    'user' to auth.uid().
--    Callers checked: Parmasi and Tenvi both call it with the admin client; Tenvi's
--    session-client fallback will fail and fall through to its admin-client path.
revoke execute on function public.enroll_user_in_website(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.enroll_user_in_website(uuid, uuid, text, text)
  to service_role;
