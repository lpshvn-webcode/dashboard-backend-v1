import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

// Validate JWT from Supabase Auth - used for user-facing endpoints
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.split(' ')[1];

  // Use anon key + user's JWT to validate
  const userSupabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error } = await userSupabase.auth.getUser();
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  (req as any).user = user;
  next();
};

// Validate cron secret - used for cron job endpoints
export const requireCronSecret = (req: Request, res: Response, next: NextFunction) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
