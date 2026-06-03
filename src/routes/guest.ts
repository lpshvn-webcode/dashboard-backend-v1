import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import {
  createOrReplaceGuestLink,
  formatGuestLinkResponse,
  getGuestLinkForOwnedClient,
  getPublicClientByGuestToken,
  revokeGuestLink,
} from '../services/guest-links';
import { queryCrossAnalytics, queryCrossKpis } from '../services/cross-analytics-query';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const { clientId } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const result = await getGuestLinkForOwnedClient(clientId, userId);
  if (!result) return res.status(403).json({ error: 'Access denied' });

  res.json({
    data: formatGuestLinkResponse(result.clientId, result.clientName, result.guestLink),
  });
});

router.post('/', requireAuth, async (req, res) => {
  const clientId = (req.body?.clientId || req.query.clientId) as string;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const result = await createOrReplaceGuestLink(clientId, userId);
  if (!result) return res.status(403).json({ error: 'Access denied' });

  res.json({
    data: formatGuestLinkResponse(result.clientId, result.clientName, result.guestLink),
  });
});

router.delete('/', requireAuth, async (req, res) => {
  const clientId = (req.body?.clientId || req.query.clientId) as string;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const result = await revokeGuestLink(clientId, userId);
  if (!result) return res.status(403).json({ error: 'Access denied' });

  res.json({
    data: formatGuestLinkResponse(result.clientId, result.clientName, result.guestLink),
  });
});

router.get('/public/meta', async (req, res) => {
  const { token } = req.query as Record<string, string>;
  if (!token) return res.status(400).json({ error: 'token required' });

  try {
    const client = await getPublicClientByGuestToken(token);
    if (!client) return res.status(404).json({ error: 'Guest link unavailable' });

    res.json({
      data: {
        clientId: client.clientId,
        clientName: client.clientName,
        projectName: client.settings?.projectName || client.clientName,
        expiresAt: client.guestLink.expiresAt,
        defaultExchangeRate: Number(client.settings?.defaultExchangeRate) || 490,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/public/cross-analytics', async (req, res) => {
  const { token, dateFrom, dateTo, level, campaignId, campaignName, adsetName, platform, matchedOnly } =
    req.query as Record<string, string>;

  if (!token) return res.status(400).json({ error: 'token required' });
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo required' });

  try {
    const client = await getPublicClientByGuestToken(token);
    if (!client) return res.status(404).json({ error: 'Guest link unavailable' });

    const payload = await queryCrossAnalytics(supabase, {
      clientId: client.clientId,
      dateFrom,
      dateTo,
      level,
      campaignId,
      campaignName,
      adsetName,
      platform,
      matchedOnly,
    });

    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/public/cross-kpis', async (req, res) => {
  const { token, dateFrom, dateTo, platform, matchedOnly } = req.query as Record<string, string>;

  if (!token) return res.status(400).json({ error: 'token required' });
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo required' });

  try {
    const client = await getPublicClientByGuestToken(token);
    if (!client) return res.status(404).json({ error: 'Guest link unavailable' });

    const payload = await queryCrossKpis(supabase, {
      clientId: client.clientId,
      dateFrom,
      dateTo,
      platform,
      matchedOnly,
    });

    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
