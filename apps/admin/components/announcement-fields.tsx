'use client';

import { useState } from 'react';
import { SUPPORTED_LOCALES, ANNOUNCEMENT_TARGETS } from '@tvwatch/shared';

export type LocaleMap = Record<string, string>;

/** Per-locale text editor. English is always visible; other locales are behind a
 *  "Show more languages" disclosure. Empty values fall back to English client-side. */
export function LocaleFields({
  label,
  value,
  onChange,
  optional,
  multiline,
}: {
  label: string;
  value: LocaleMap;
  onChange: (v: LocaleMap) => void;
  optional?: boolean;
  multiline?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const others = SUPPORTED_LOCALES.filter((l) => l.code !== 'en');

  const set = (code: string, v: string) => onChange({ ...value, [code]: v });
  const input = (code: string, placeholder: string) =>
    multiline ? (
      <textarea
        value={value[code] ?? ''}
        onChange={(e) => set(code, e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm focus:border-accent focus:outline-none"
      />
    ) : (
      <input
        type="text"
        value={value[code] ?? ''}
        onChange={(e) => set(code, e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm focus:border-accent focus:outline-none"
      />
    );

  return (
    <div>
      <label className="text-xs text-white/40 uppercase">
        {label}
        {optional ? ' (optional)' : ''}
      </label>
      <div className="mt-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/30 w-16 shrink-0">English *</span>
          <div className="flex-1">
            {input(
              'en',
              optional ? 'English (fallback for all languages)' : 'English text (required)',
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-accent hover:underline"
        >
          {expanded ? '▾ Hide other languages' : '▸ Show more languages'}
        </button>
        {expanded ? (
          <div className="space-y-2 pl-2 border-l border-border/50">
            {others.map((l) => (
              <div key={l.code} className="flex items-center gap-2">
                <span className="text-xs text-white/30 w-16 shrink-0">{l.nativeName}</span>
                <div className="flex-1">{input(l.code, `Falls back to English if empty`)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const NAV_TARGETS = ANNOUNCEMENT_TARGETS.filter((t) => t !== 'none' && t !== 'external');
const TARGET_LABELS: Record<string, string> = {
  none: 'No action',
  import: 'Go to Import',
  explore: 'Go to Explore',
  'my-lists': 'Go to My Lists',
  'followed-lists': 'Go to Followed Lists',
  stats: 'Go to Stats',
  settings: 'Go to Settings',
  notifications: 'Go to Notifications',
  show: 'Open a Show',
  list: 'Open a List',
  external: 'Open external URL',
};

export type ActionState = {
  target: string;
  params: { showId?: string; listId?: string; url?: string };
};

/** Whitelisted action selector. Shows param inputs only for targets that need them. */
export function ActionConfig({
  value,
  onChange,
}: {
  value: ActionState;
  onChange: (v: ActionState) => void;
}) {
  const setTarget = (target: string) => {
    const params = { ...value.params };
    if (target !== 'show') delete params.showId;
    if (target !== 'list') delete params.listId;
    if (target !== 'external') delete params.url;
    onChange({ target, params });
  };

  return (
    <div className="space-y-2">
      <label className="text-xs text-white/40 uppercase">Action (tap behavior)</label>
      <select
        value={value.target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm focus:border-accent focus:outline-none"
      >
        <option value="none">{TARGET_LABELS.none}</option>
        <optgroup label="Navigate">
          {NAV_TARGETS.map((t) => (
            <option key={t} value={t}>
              {TARGET_LABELS[t]}
            </option>
          ))}
        </optgroup>
        <option value="external">{TARGET_LABELS.external}</option>
      </select>
      {value.target === 'show' ? (
        <input
          type="text"
          placeholder="Show media ID"
          value={value.params.showId ?? ''}
          onChange={(e) =>
            onChange({ ...value, params: { ...value.params, showId: e.target.value } })
          }
          className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm font-mono focus:border-accent focus:outline-none"
        />
      ) : null}
      {value.target === 'list' ? (
        <input
          type="text"
          placeholder="List ID"
          value={value.params.listId ?? ''}
          onChange={(e) =>
            onChange({ ...value, params: { ...value.params, listId: e.target.value } })
          }
          className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm font-mono focus:border-accent focus:outline-none"
        />
      ) : null}
      {value.target === 'external' ? (
        <input
          type="url"
          placeholder="https://..."
          value={value.params.url ?? ''}
          onChange={(e) => onChange({ ...value, params: { ...value.params, url: e.target.value } })}
          className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm focus:border-accent focus:outline-none"
        />
      ) : null}
    </div>
  );
}

export const ICON_OPTIONS = [
  'information-circle-outline',
  'megaphone-outline',
  'download-outline',
  'notifications-outline',
  'bulb-outline',
  'gift-outline',
  'star-outline',
  'trophy-outline',
  'flame-outline',
  'sparkles-outline',
  'calendar-outline',
  'pricetag-outline',
  'film-outline',
  'tv-outline',
  'list-outline',
  'people-outline',
  'chatbubble-outline',
  'warning-outline',
  'checkmark-circle-outline',
  'rocket-outline',
];
