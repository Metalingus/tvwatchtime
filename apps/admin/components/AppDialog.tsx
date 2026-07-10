'use client';

import { useEffect, useRef } from 'react';
import { dialog } from '@/lib/dialog';
import { pressDialogButton } from '@tvwatch/shared';
import type { DialogEntry } from '@tvwatch/shared';

const VARIANT_CLASS: Record<string, string> = {
  primary: 'bg-accent text-bg hover:bg-accent-muted',
  danger: 'bg-danger text-white hover:bg-danger/80',
  secondary: 'bg-elevated text-white hover:bg-elevated/80',
  ghost: 'bg-transparent text-white/70 border border-border hover:text-white hover:bg-elevated/50',
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea',
  'input',
  'select',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function AppDialog({ entry }: { entry: DialogEntry }) {
  const { id, title, description, content, dismissible, showCloseButton, buttons } = entry;
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // ESC to close (only when dismissible) + body scroll lock.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        dialog.dismiss(id);
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap: keep Tab cycling inside the dialog.
        const root = dialogRef.current;
        if (!root) return;
        const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (nodes.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog.
    const root = dialogRef.current;
    if (root) {
      const first = root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus();
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [id, dismissible]);

  const close = () => {
    if (dismissible) dialog.dismiss(id);
  };

  const handleButton = (index: number) => pressDialogButton(dialog, entry, index);
  const stackButtons = buttons.length > 2;
  const CustomContent = content as React.ReactNode | undefined;

  const titleId = `dialog-title-${id}`;
  const descId = description ? `dialog-desc-${id}` : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) close();
      }}
    >
      <div className="absolute inset-0 bg-black/75" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={descId}
        tabIndex={-1}
        className="relative z-10 w-full max-w-md max-h-[85vh] flex flex-col bg-surface border border-border rounded-2xl p-6 outline-none shadow-2xl"
      >
        {showCloseButton ? (
          <button
            onClick={close}
            aria-label="Close dialog"
            className="absolute top-3 right-3 p-1.5 text-white/40 hover:text-white transition rounded-lg hover:bg-elevated"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : null}

        <div className="overflow-y-auto pr-2">
          {title ? (
            <h2 id={titleId} className={`text-lg font-bold text-white ${description ? 'mb-2' : ''} ${showCloseButton ? 'pr-6' : ''}`}>
              {title}
            </h2>
          ) : null}
          {description ? (
            <p id={descId} className="text-sm text-white/60 leading-relaxed">
              {description}
            </p>
          ) : null}
          {CustomContent ? <div className="mt-3">{CustomContent}</div> : null}
        </div>

        <div className={`flex gap-2 mt-5 ${stackButtons ? 'flex-col-reverse' : 'justify-end'}`}>
          {buttons.map((b, i) => {
            const variant = (b.variant ?? 'secondary') as keyof typeof VARIANT_CLASS;
            return (
              <button
                key={`${b.label}-${i}`}
                onClick={() => handleButton(i)}
                disabled={b.disabled || b.loading}
                className={`px-4 py-2.5 rounded-lg font-semibold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  VARIANT_CLASS[variant] ?? VARIANT_CLASS.secondary
                } ${stackButtons ? 'w-full' : ''} min-w-[96px]`}
              >
                {b.loading ? <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin align-middle" /> : b.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
