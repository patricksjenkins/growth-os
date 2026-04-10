import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// Growth OS API
const API_BASE = import.meta.env.VITE_API_URL || 'https://growth-os-production-22b3.up.railway.app';

// Supabase Auth client
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://ffvezmgvwpohbsbigcdb.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

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
