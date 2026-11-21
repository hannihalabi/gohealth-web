-- The existing function is an event_trigger used internally for automatic RLS.
-- It is not a client RPC; removing client EXECUTE preserves the owner/trigger path.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
