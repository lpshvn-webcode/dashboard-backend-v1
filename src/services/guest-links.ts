import crypto from 'crypto';
import { supabase } from '../lib/supabase';

const GUEST_LINK_TTL_DAYS = 30;

export interface GuestLinkSettings {
  token: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ClientRow {
  id: string;
  name: string;
  user_id: string;
  settings: Record<string, any> | null;
}

interface OwnedClientGuestLinkResult {
  clientId: string;
  clientName: string;
  guestLink: GuestLinkSettings | null;
}

export interface PublicGuestClient {
  clientId: string;
  clientName: string;
  guestLink: GuestLinkSettings;
  settings: Record<string, any>;
}

function readGuestLink(settings: Record<string, any> | null | undefined): GuestLinkSettings | null {
  const raw = settings?.guestLink;
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.token || !raw.expiresAt) return null;

  return {
    token: String(raw.token),
    expiresAt: String(raw.expiresAt),
    revokedAt: raw.revokedAt ? String(raw.revokedAt) : null,
    createdAt: raw.createdAt ? String(raw.createdAt) : String(raw.expiresAt),
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : String(raw.expiresAt),
  };
}

function writeGuestLink(settings: Record<string, any> | null | undefined, guestLink: GuestLinkSettings | null) {
  const next = { ...(settings || {}) } as Record<string, any>;
  if (!guestLink) {
    delete next.guestLink;
    return next;
  }
  next.guestLink = guestLink;
  return next;
}

function isGuestLinkActive(guestLink: GuestLinkSettings | null): guestLink is GuestLinkSettings {
  if (!guestLink) return false;
  if (guestLink.revokedAt) return false;
  return new Date(guestLink.expiresAt).getTime() > Date.now();
}

function buildExpiryDate() {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + GUEST_LINK_TTL_DAYS);
  return expiry.toISOString();
}

function generateGuestToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function getOwnedClient(clientId: string, userId: string): Promise<ClientRow | null> {
  const { data, error } = await supabase
    .from('clients')
    .select('id,name,user_id,settings')
    .eq('id', clientId)
    .single();

  if (error || !data || data.user_id !== userId) return null;
  return data as ClientRow;
}

async function updateClientSettings(clientId: string, settings: Record<string, any>) {
  const { error } = await supabase
    .from('clients')
    .update({ settings })
    .eq('id', clientId);

  if (error) throw new Error(error.message);
}

export function formatGuestLinkResponse(clientId: string, clientName: string, guestLink: GuestLinkSettings | null) {
  const isActive = isGuestLinkActive(guestLink);
  return {
    clientId,
    clientName,
    isActive,
    expiresAt: guestLink?.expiresAt || null,
    revokedAt: guestLink?.revokedAt || null,
    createdAt: guestLink?.createdAt || null,
    updatedAt: guestLink?.updatedAt || null,
    sharePath: guestLink ? `/#/guest/${guestLink.token}` : null,
  };
}

export async function getGuestLinkForOwnedClient(clientId: string, userId: string): Promise<OwnedClientGuestLinkResult | null> {
  const client = await getOwnedClient(clientId, userId);
  if (!client) return null;

  return {
    clientId: client.id,
    clientName: client.name,
    guestLink: readGuestLink(client.settings),
  };
}

export async function createOrReplaceGuestLink(clientId: string, userId: string): Promise<OwnedClientGuestLinkResult | null> {
  const client = await getOwnedClient(clientId, userId);
  if (!client) return null;

  const now = new Date().toISOString();
  const existing = readGuestLink(client.settings);
  const nextGuestLink: GuestLinkSettings = {
    token: generateGuestToken(),
    expiresAt: buildExpiryDate(),
    revokedAt: null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await updateClientSettings(client.id, writeGuestLink(client.settings, nextGuestLink));

  return {
    clientId: client.id,
    clientName: client.name,
    guestLink: nextGuestLink,
  };
}

export async function revokeGuestLink(clientId: string, userId: string): Promise<OwnedClientGuestLinkResult | null> {
  const client = await getOwnedClient(clientId, userId);
  if (!client) return null;

  const existing = readGuestLink(client.settings);
  if (!existing) {
    return {
      clientId: client.id,
      clientName: client.name,
      guestLink: null,
    };
  }

  const revoked: GuestLinkSettings = {
    ...existing,
    revokedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await updateClientSettings(client.id, writeGuestLink(client.settings, revoked));

  return {
    clientId: client.id,
    clientName: client.name,
    guestLink: revoked,
  };
}

export async function getPublicClientByGuestToken(token: string): Promise<PublicGuestClient | null> {
  if (!token) return null;

  const PAGE_SIZE = 500;
  let page = 0;

  while (true) {
    const { data, error } = await supabase
      .from('clients')
      .select('id,name,settings')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      const guestLink = readGuestLink(row.settings);
      if (!guestLink) continue;
      if (guestLink.token !== token) continue;
      if (!isGuestLinkActive(guestLink)) return null;

      return {
        clientId: row.id,
        clientName: row.name,
        guestLink,
        settings: (row.settings || {}) as Record<string, any>,
      };
    }

    if (data.length < PAGE_SIZE) break;
    page++;
  }

  return null;
}
