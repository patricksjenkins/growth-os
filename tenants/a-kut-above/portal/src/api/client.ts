import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// Growth OS API
const API_BASE = import.meta.env.VITE_API_URL || 'https://growth-os-production-22b3.up.railway.app';

// Supabase Auth client
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://ffvezmgvwpohbsbigcdb.supabase.co';
// Public Supabase anon key (safe to ship in-browser; RLS protects data). Env var overrides.
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmdmV6bWd2d3BvaGJzYmlnY2RiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MTE0NDcsImV4cCI6MjA5MTM4NzQ0N30.mcy46ikXGr-Pl8HtVqHPuShzBj7gqN4OmLhqRX42-QY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const client = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

// Attach Supabase JWT to every request
client.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      supabase.auth.signOut();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default client;
