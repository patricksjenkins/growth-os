import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../api/client';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthenticated(!!session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(!!session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return <div className="loading">Loading...</div>;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
