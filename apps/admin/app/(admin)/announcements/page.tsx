'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';
import { LocaleFields, ActionConfig, ICON_OPTIONS, type LocaleMap, type ActionState } from '@/components/announcement-fields';

interface AnnouncementRow {
  id: string;
  revision: number;
  icon: string;
  title: LocaleMap;
  message: LocaleMap;
  actionLabel: LocaleMap | null;
  action: { type: string; target?: string; params?: any };
  active: boolean;
  alsoPush: boolean;
  pushSentAt: string | null;
  createdAt: string;
}

const emptyForm = () => ({
  icon: 'information-circle-outline',
  title: { en: '' } as LocaleMap,
  message: { en: '' } as LocaleMap,
  actionLabel: { en: '' } as LocaleMap,
  hasCta: false,
  action: { target: 'none', params: {} } as ActionState,
  alsoPush: false,
  active: false,
});

export default function AnnouncementsPage() {
  const { user } = useAuth();
  const canEdit = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
  const [items, setItems] = useState<AnnouncementRow[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; data: ReturnType<typeof emptyForm> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.get('/admin/announcements').then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);

  const startCreate = () => setEditing({ id: null, data: emptyForm() });
  const startEdit = (a: AnnouncementRow) =>
    setEditing({
      id: a.id,
      data: {
        icon: a.icon,
        title: a.title,
        message: a.message,
        actionLabel: a.actionLabel ?? { en: '' },
        hasCta: !!a.actionLabel,
        action: { target: a.action?.target ?? 'none', params: a.action?.params ?? {} },
        alsoPush: a.alsoPush,
        active: a.active,
      },
    });

  const buildPayload = () => {
    const d = editing!.data;
    return {
      icon: d.icon,
      title: d.title,
      message: d.message,
      actionLabel: d.hasCta ? d.actionLabel : null,
      actionTarget: d.action.target,
      actionParams: d.action.params,
      alsoPush: d.alsoPush,
    };
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editing!.id) {
        await api.patch(`/admin/announcements/${editing!.id}`, payload);
      } else {
        const res = await api.post('/admin/announcements', payload);
        if (editing!.data.active && res.data?.id) {
          await api.post(`/admin/announcements/${res.data.id}/activate`, { alsoPush: editing!.data.alsoPush });
        }
      }
      setEditing(null);
      load();
    } finally {
      setSaving(false);
    }
  };

  const activate = async (a: AnnouncementRow, alsoPush: boolean) => {
    setBusy(a.id);
    try { await api.post(`/admin/announcements/${a.id}/activate`, { alsoPush }); load(); } finally { setBusy(null); }
  };
  const deactivate = async (a: AnnouncementRow) => {
    setBusy(a.id);
    try { await api.post(`/admin/announcements/${a.id}/deactivate`); load(); } finally { setBusy(null); }
  };
  const reshow = async (a: AnnouncementRow) => {
    setBusy(a.id);
    try { await api.post(`/admin/announcements/${a.id}/reshow`); load(); } finally { setBusy(null); }
  };
  const sendPush = async (a: AnnouncementRow) => {
    if (!confirm('Send a broadcast push to ALL users now?')) return;
    setBusy(a.id);
    try { await api.post(`/admin/announcements/${a.id}/push`); load(); } finally { setBusy(null); }
  };
  const remove = async (a: AnnouncementRow) => {
    if (!confirm('Delete this announcement?')) return;
    setBusy(a.id);
    try { await api.delete(`/admin/announcements/${a.id}`); load(); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Announcements</h1>
          <div className="text-sm text-white/40 mt-1">Configurable in-app banner shown on the Shows tab. One active at a time.</div>
        </div>
        {canEdit ? (
          <button onClick={startCreate} className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm">+ New Announcement</button>
        ) : null}
      </div>

      {editing ? (
        <div className="bg-surface rounded-xl p-5 border border-border space-y-4">
          <div className="text-sm font-semibold text-white/70">{editing.id ? 'Edit announcement' : 'New announcement'}</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/40 uppercase">Icon</label>
              <select
                value={editing.data.icon}
                onChange={(e) => setEditing({ ...editing, data: { ...editing.data, icon: e.target.value } })}
                className="w-full mt-1 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm"
              >
                {ICON_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm text-white/60">
              <input type="checkbox" checked={editing.data.alsoPush} onChange={(e) => setEditing({ ...editing, data: { ...editing.data, alsoPush: e.target.checked } })} />
              Also send a broadcast push on activate (one-shot)
            </label>
          </div>
          <LocaleFields label="Title" value={editing.data.title} onChange={(v) => setEditing({ ...editing, data: { ...editing.data, title: v } })} />
          <LocaleFields label="Message" value={editing.data.message} onChange={(v) => setEditing({ ...editing, data: { ...editing.data, message: v } })} multiline />
          <label className="flex items-center gap-2 text-sm text-white/60">
            <input type="checkbox" checked={editing.data.hasCta} onChange={(e) => setEditing({ ...editing, data: { ...editing.data, hasCta: e.target.checked } })} />
            Include a call-to-action button
          </label>
          {editing.data.hasCta ? (
            <LocaleFields label="Action label" value={editing.data.actionLabel} onChange={(v) => setEditing({ ...editing, data: { ...editing.data, actionLabel: v } })} optional />
          ) : null}
          <ActionConfig value={editing.data.action} onChange={(v) => setEditing({ ...editing, data: { ...editing.data, action: v } })} />
          {!editing.id ? (
            <label className="flex items-center gap-2 text-sm text-white/60">
              <input type="checkbox" checked={editing.data.active} onChange={(e) => setEditing({ ...editing, data: { ...editing.data, active: e.target.checked } })} />
              Set as active on save
            </label>
          ) : null}
          <div className="flex gap-2 pt-2">
            <button onClick={save} disabled={saving} className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
            <button onClick={() => setEditing(null)} className="px-4 py-2 bg-surface-alt text-white/60 rounded-lg text-sm">Cancel</button>
          </div>
        </div>
      ) : null}

      {items.length === 0 && !editing ? (
        <div className="bg-surface rounded-xl p-8 border border-border text-center text-white/40 text-sm">No announcements yet.</div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <div key={a.id} className="bg-surface rounded-xl p-5 border border-border">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{iconGlyph(a.icon)}</span>
                    <span className="font-semibold truncate">{a.title?.en ?? '(no title)'}</span>
                    {a.active ? <Badge color="success">Active</Badge> : null}
                    {a.pushSentAt ? <Badge color="info">Pushed</Badge> : null}
                  </div>
                  <div className="text-sm text-white/50 mt-1 line-clamp-2">{a.message?.en}</div>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-white/30">
                    <span>Revision: {a.revision}</span>
                    <span>Target: {a.action?.target ?? 'none'}</span>
                    <span>Created: {new Date(a.createdAt).toLocaleString()}</span>
                    {a.pushSentAt ? <span>Pushed: {new Date(a.pushSentAt).toLocaleString()}</span> : null}
                  </div>
                </div>
                {canEdit ? (
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    {a.active ? (
                      <button onClick={() => deactivate(a)} disabled={busy === a.id} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 hover:text-white">Deactivate</button>
                    ) : (
                      <div className="flex gap-1.5">
                        <button onClick={() => activate(a, false)} disabled={busy === a.id} className="px-3 py-1.5 bg-accent text-bg rounded-lg text-xs font-bold">Activate</button>
                        <button onClick={() => activate(a, true)} disabled={busy === a.id} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent">Activate + Push</button>
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      <button onClick={() => startEdit(a)} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent">Edit</button>
                      <button onClick={() => reshow(a)} disabled={busy === a.id} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 hover:text-white" title="Re-show to everyone who dismissed it">Re-show</button>
                      <button onClick={() => sendPush(a)} disabled={busy === a.id} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent">Push</button>
                      <button onClick={() => remove(a)} disabled={busy === a.id} className="px-3 py-1.5 text-danger text-xs hover:underline">Delete</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function iconGlyph(icon: string): string {
  const map: Record<string, string> = {
    'information-circle-outline': 'ℹ️', 'megaphone-outline': '📢', 'download-outline': '⬇️',
    'notifications-outline': '🔔', 'bulb-outline': '💡', 'gift-outline': '🎁', 'star-outline': '⭐',
    'trophy-outline': '🏆', 'flame-outline': '🔥', 'sparkles-outline': '✨', 'calendar-outline': '📅',
    'pricetag-outline': '🏷️', 'film-outline': '🎬', 'tv-outline': '📺', 'list-outline': '📋',
    'people-outline': '👥', 'chatbubble-outline': '💬', 'warning-outline': '⚠️',
    'checkmark-circle-outline': '✅', 'rocket-outline': '🚀',
  };
  return map[icon] ?? 'ℹ️';
}
