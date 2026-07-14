'use client';

import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const CATEGORY_LABELS: Record<string, string> = {
  tmdb: 'TMDb Configuration',
  tvmaze: 'TVmaze Configuration',
  trakt: 'Trakt Configuration',
  push: 'Push Notifications',
  notifications: 'Notifications',
  limits: 'Rate Limits',
  images: 'Image Processing',
};

const SENSITIVE_HINTS: Record<string, string> = {
  TMDB_API_KEY: '32-char hex key from themoviedb.org',
  TVMAZE_API_KEY: 'Optional - TVmaze works without a key',
  TRAKT_CLIENT_ID: 'From trakt.tv API settings',
  TRAKT_CLIENT_SECRET: 'From trakt.tv API settings',
  EXPO_ACCESS_TOKEN: 'From expo.dev access tokens',
  WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS: 'Days before the same show is reminded again (rotation). Default 30.',
  WATCHLIST_REMINDER_STALE_DAYS: 'Days since last watch before a show is considered stale/eligible. Default 14.',
};

export default function SettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<any[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const load = () => api.get('/admin/settings').then((r) => setSettings(r.data));
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const s of settings) {
      if (!map.has(s.category)) map.set(s.category, []);
      map.get(s.category)!.push(s);
    }
    return map;
  }, [settings]);

  const startEdit = (key: string, currentValue: string, encrypted: boolean) => {
    if (encrypted && !revealedValues[key]) {
      // Fetch decrypted value for editing
      api.get(`/admin/settings/${key}`).then((r) => {
        setRevealedValues({ ...revealedValues, [key]: r.data.value });
        setEditValue(r.data.value);
        setEditing(key);
      });
    } else {
      setEditValue(encrypted ? (revealedValues[key] || '') : currentValue);
      setEditing(key);
    }
  };

  const save = async (key: string, encrypted: boolean) => {
    setSaving(key);
    try {
      await api.patch(`/admin/settings/${key}`, { value: editValue, encrypted });
      setEditing(null);
      setRevealedKeys(new Set());
      load();
    } finally { setSaving(null); }
  };

  const reveal = async (key: string) => {
    const r = await api.get(`/admin/settings/${key}`);
    setRevealedValues({ ...revealedValues, [key]: r.data.value });
    setRevealedKeys(new Set([...revealedKeys, key]));
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Settings by category */}
      {[...categories.entries()].map(([cat, items]) => (
        <div key={cat} className="bg-surface rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-surface-alt/50">
            <div className="text-sm font-semibold">{CATEGORY_LABELS[cat] || cat}</div>
          </div>
          <div className="divide-y divide-border/50">
            {items.map((s) => {
              const isEditing = editing === s.key;
              const isEncrypted = s.encrypted;
              const showValue = isEncrypted ? (revealedKeys.has(s.key) ? revealedValues[s.key] : s.value) : s.value;
              return (
                <div key={s.key} className="px-5 py-3 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono font-medium">{s.key}</span>
                      {s.encrypted ? <span className="text-xs px-1.5 py-0.5 rounded bg-danger/15 text-danger">🔒 Encrypted</span> : null}
                      {!s.isSet ? <span className="text-xs px-1.5 py-0.5 rounded bg-warning/15 text-warning">Not set</span> : null}
                    </div>
                    {SENSITIVE_HINTS[s.key] ? <div className="text-xs text-white/30 mt-0.5">{SENSITIVE_HINTS[s.key]}</div> : null}
                    {isEditing ? (
                      <input
                        type={s.encrypted ? 'password' : 'text'}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="w-full mt-2 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm font-mono focus:border-accent focus:outline-none"
                        placeholder={s.encrypted ? 'Enter new value...' : 'Enter value...'}
                      />
                    ) : (
                      <div className="text-sm text-white/50 mt-0.5 font-mono truncate">
                        {s.isSet ? showValue || '••••••••' : <span className="text-white/30 italic">Using .env default</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isEditing ? (
                      <>
                        <button onClick={() => save(s.key, s.encrypted)} disabled={saving === s.key} className="px-3 py-1.5 bg-accent text-bg font-bold rounded-lg text-xs disabled:opacity-50">
                          {saving === s.key ? 'Saving...' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-surface-alt text-white/60 rounded-lg text-xs">Cancel</button>
                      </>
                    ) : isSuperAdmin ? (
                      <>
                        {s.encrypted && s.isSet && !revealedKeys.has(s.key) ? (
                          <button onClick={() => reveal(s.key)} className="px-3 py-1.5 bg-surface-alt text-white/60 rounded-lg text-xs hover:text-white">👁 Reveal</button>
                        ) : null}
                        <button onClick={() => startEdit(s.key, showValue || '', s.encrypted)} className="px-3 py-1.5 bg-surface-alt text-accent rounded-lg text-xs border border-border hover:border-accent">
                          {s.isSet ? 'Edit' : 'Set'}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Feature Flags (existing) */}
      <FeatureFlagsSection />

      {/* System Info */}
      <div className="bg-surface rounded-xl p-6 border border-border">
        <div className="text-sm font-semibold text-white/70 mb-4">System Information</div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <InfoRow label="Encryption" value="AES-256-GCM" color="text-success" />
          <InfoRow label="Settings Cache" value="10s TTL" />
          <InfoRow label="Storage" value="PostgreSQL + encrypted columns" />
          <InfoRow label="Fallback" value=".env (when DB value empty)" color="text-warning" />
        </div>
        {!isSuperAdmin ? (
          <div className="mt-4 text-xs text-white/30 bg-surface-alt/50 rounded-lg px-4 py-2">
            Only Super Admins can view and edit settings values.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FeatureFlagsSection() {
  const [flags, setFlags] = useState<any[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => { api.get('/admin/feature-flags').then((r) => setFlags(r.data)); }, []);

  const toggle = async (key: string, current: boolean) => {
    setSaving(key);
    try {
      await api.patch('/admin/feature-flags', { key, value: !current });
      setFlags((f) => f.map((x) => x.key === key ? { ...x, value: !current } : x));
    } finally { setSaving(null); }
  };

  const descriptions: Record<string, string> = {
    comments_enabled: 'Allow users to post comments on shows, movies and episodes',
    public_profiles: 'Make user profiles visible to other users',
    imports_enabled: 'Allow users to import watch history from other apps',
    push_notifications: 'Send push notifications for new episodes and badges',
    recommendations: 'Generate personalized recommendations based on watch history',
  };

  return (
    <div className="bg-surface rounded-xl p-6 border border-border">
      <div className="text-sm font-semibold text-white/70 mb-4">Feature Flags</div>
      <div className="space-y-3">
        {flags.map((f) => (
          <div key={f.key} className="flex items-center justify-between py-3 border-b border-border/50 last:border-0">
            <div>
              <div className="text-sm font-medium">{f.key.replace(/_/g, ' ')}</div>
              <div className="text-xs text-white/40">{descriptions[f.key] || ''}</div>
            </div>
            <button onClick={() => toggle(f.key, f.value)} disabled={saving === f.key} className={`relative w-12 h-6 rounded-full transition ${f.value ? 'bg-accent' : 'bg-surface-alt'}`}>
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${f.value ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoRow({ label, value, color = 'text-white/60' }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <span className="text-white/40">{label}: </span>
      <span className={color}>{value}</span>
    </div>
  );
}
