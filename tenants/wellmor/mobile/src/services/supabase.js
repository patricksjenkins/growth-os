/**
 * Supabase Client for WellMor Mobile
 * Uses AsyncStorage for session persistence across app restarts.
 *
 * Hardcoded fallback values ensure the client initializes even when
 * env vars are missing in production EAS builds.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Hardcode fallbacks so production builds work even if env vars don't inject
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  'https://ffvezmgvwpohbsbigcdb.supabase.co';

const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmdmV6bWd2d3BvaGJzYmlnY2RiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MTE0NDcsImV4cCI6MjA5MTM4NzQ0N30.mcy46ikXGr-Pl8HtVqHPuShzBj7gqN4OmLhqRX42-QY';

let supabaseInstance;
try {
  supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
} catch (err) {
  console.error('Failed to create Supabase client:', err);
  // Create a minimal stub so the app doesn't crash on import
  supabaseInstance = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInWithPassword: async () => ({ error: new Error('Supabase client failed to initialize') }),
      signOut: async () => {},
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  };
}

export const supabase = supabaseInstance;

/**
 * Get the current session's access token, or null if not logged in.
 */
export async function getAccessToken() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || null;
  } catch (err) {
    console.warn('getAccessToken failed:', err);
    return null;
  }
}
