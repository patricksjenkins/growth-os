import { useState, useCallback, useEffect } from 'react';
import { login as loginApi, logout as logoutApi } from '../api/auth';
import { supabase } from '../api/client';

export function useAuth() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [role, setRole] = useState<string>('owner');

  // Check session on mount
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsAuthenticated(!!session);
      if (session?.user) {
        setRole(session.user.app_metadata?.role || 'owner');
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthenticated(!!session);
      if (session?.user) {
        setRole(session.user.app_metadata?.role || 'owner');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = useCallback(async (username: string, password: string, _stayLoggedIn: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await loginApi(username, password);
      if (res.success) {
        setIsAuthenticated(true);
        setRole(res.data?.role || 'owner');
        return true;
      } else {
        setError(res.error || 'Login failed. Please check your credentials.');
        return false;
      }
    } catch (err: unknown) {
      setError('Login failed. Please try again.');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await logoutApi();
    setIsAuthenticated(false);
    setRole('owner');
    window.location.href = '/login';
  }, []);

  const isCrew = role === 'crew';
  const isOwner = role !== 'crew';

  return { isAuthenticated, role, isCrew, isOwner, login, logout, loading, error };
}
