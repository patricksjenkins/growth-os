import { Router, Request, Response } from 'express';
import { supabaseAnon, supabase } from '../config/supabase';
import { z } from 'zod';
import { validate } from '../middleware/validate';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  password: z.string().min(1),
});

router.post('/login', validate(loginSchema), async (req: Request, res: Response) => {
  try {
    const { username, email: rawEmail, password } = req.body;

    // Accept either username or email field (supports old and new app versions)
    const loginInput = username || rawEmail || '';
    const email = loginInput.includes('@') ? loginInput : `${loginInput}@akutabovetreeservice.com`;

    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

    if (error) {
      return res.status(401).json({ success: false, error: error.message });
    }

    // Get user role from profile
    let role = 'standard';
    if (data.user) {
      const { data: profile, error: profileError } = await supabase
        .from('users')
        .select('role')
        .eq('id', data.user.id)
        .single();

      if (profileError) {
        console.error('Profile lookup error:', profileError.message);
        // Still allow login even if profile lookup fails
      }
      role = profile?.role || 'standard';
    }

    res.json({
      success: true,
      data: {
        token: data.session?.access_token,
        refreshToken: data.session?.refresh_token,
        user: data.user,
        role,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error.message);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: refreshToken });

  if (error) {
    return res.status(401).json({ success: false, error: error.message });
  }

  res.json({
    success: true,
    data: {
      token: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
    },
  });
});

export default router;
