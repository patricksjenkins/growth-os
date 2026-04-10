import { supabase } from './client';

// Username-to-email mapping so users can log in with a simple username
const USERNAME_MAP: Record<string, string> = {
  owner: 'owner@akutabovetreeservices.com',
  crew: 'crew@akutabovetreeservices.com',
};

export async function login(username: string, password: string) {
  const trimmed = username.trim().toLowerCase();
  const email = USERNAME_MAP[trimmed] || trimmed;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { success: false, error: error.message };
  }

  // Extract role from app_metadata (set during user creation)
  const role = data.user?.app_metadata?.role || 'owner';

  return {
    success: true,
    data: {
      token: data.session?.access_token || '',
      refreshToken: data.session?.refresh_token || '',
      role,
    },
  };
}

export async function logout() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}
