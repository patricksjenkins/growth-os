import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'admin' | 'standard' | 'crew';
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  // Get user profile with role
  const { data: profile } = await supabase
    .from('users')
    .select('role, full_name')
    .eq('id', user.id)
    .single();

  req.user = {
    id: user.id,
    email: user.email || '',
    role: profile?.role || 'standard',
  };

  next();
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
};
