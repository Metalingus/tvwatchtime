// Themed dialog system — shared, framework-agnostic types + controller factory.
// Each app (mobile, admin) creates one singleton instance via createDialogController()
// and renders its own platform-specific host that subscribes to the controller.

export type DialogVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface DialogButton {
  label: string;
  variant?: DialogVariant;
  onPress?: () => void | Promise<unknown>;
  /** Close the dialog after onPress resolves successfully. Default: true. */
  closeOnPress?: boolean;
  /** Start the button in a loading state (rarely needed; the controller manages this). */
  loading?: boolean;
  disabled?: boolean;
}

export interface ShowDialogOptions {
  title?: string;
  description?: string;
  /** Custom render content. Typed as unknown here (shared has no React dep); apps cast. */
  content?: unknown;
  /** Allow backdrop / ESC / hardware-back to close. Default: true. */
  dismissible?: boolean;
  /** Show the X close button. Defaults to the value of `dismissible`. */
  showCloseButton?: boolean;
  buttons: DialogButton[];
}

export interface InfoDialogOptions {
  title?: string;
  description: string;
}

export interface ConfirmDialogOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<unknown>;
}

/** A normalized open-dialog entry as seen by the host renderer. */
export interface DialogEntry {
  id: string;
  title?: string;
  description?: string;
  content?: unknown;
  dismissible: boolean;
  showCloseButton: boolean;
  buttons: NormalizedButton[];
}

export interface NormalizedButton {
  label: string;
  variant: DialogVariant;
  onPress?: () => void | Promise<unknown>;
  closeOnPress: boolean;
  loading: boolean;
  disabled: boolean;
}

/** A normalized open-dialog entry as seen by the host renderer. */
export interface DialogEntry {
  id: string;
  title?: string;
  description?: string;
  content?: unknown;
  dismissible: boolean;
  showCloseButton: boolean;
  buttons: NormalizedButton[];
}

export interface DialogController {
  /** Current LIFO stack of open dialogs. */
  entries: DialogEntry[];
  subscribe: (listener: () => void) => () => void;
  showDialog: (options: ShowDialogOptions) => string;
  showInfo: (options: InfoDialogOptions) => string;
  showSuccess: (options: InfoDialogOptions) => string;
  showError: (options: InfoDialogOptions) => string;
  showConfirm: (options: ConfirmDialogOptions) => string;
  dismiss: (id?: string) => void;
  dismissAll: () => void;
}

function normalizeButtons(
  buttons: DialogButton[] | undefined,
): NormalizedButton[] {
  if (!buttons || buttons.length === 0) {
    return [
      { label: 'OK', variant: 'primary', closeOnPress: true, loading: false, disabled: false },
    ];
  }
  return buttons.map((b) => ({
    label: b.label,
    variant: b.variant ?? 'secondary',
    onPress: b.onPress,
    closeOnPress: b.closeOnPress ?? true,
    loading: b.loading ?? false,
    disabled: b.disabled ?? false,
  }));
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `dialog-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Create an isolated dialog controller. Each app should create exactly one singleton
 * instance so that the imperative API (showDialog/showInfo/...) and the host renderer
 * share the same state.
 */
export function createDialogController(): DialogController {
  let entries: DialogEntry[] = [];
  const listeners = new Set<() => void>();
  // Per-controller flag: while a button's async onPress is running, lock all dialogs' buttons.
  let busy = false;

  function emit() {
    for (const l of listeners) l();
  }

  function setEntries(next: DialogEntry[]) {
    entries = next;
    emit();
  }

  function open(options: ShowDialogOptions): string {
    const dismissible = options.dismissible ?? true;
    const id = nextId();
    const entry: DialogEntry = {
      id,
      title: options.title,
      description: options.description,
      content: options.content,
      dismissible,
      showCloseButton: options.showCloseButton ?? dismissible,
      buttons: normalizeButtons(options.buttons),
    };
    // LIFO: newest dialog becomes the active (top) entry.
    setEntries([...entries, entry]);
    return id;
  }

  function dismiss(id?: string) {
    if (entries.length === 0) return;
    if (!id) {
      setEntries(entries.slice(0, -1));
      return;
    }
    setEntries(entries.filter((e) => e.id !== id));
  }

  async function runButton(entry: DialogEntry, index: number) {
    const button = entry.buttons[index];
    if (!button || busy || button.disabled || button.loading) return;
    const onPress = button.onPress;
    if (!onPress) {
      if (button.closeOnPress) dismiss(entry.id);
      return;
    }

    // Show loading + lock all buttons while the action runs. Close only on successful
    // resolve; on rejection the dialog stays open so the user can retry or cancel.
    busy = true;
    markLoading(entry.id, index, true);
    let closed = false;
    try {
      await onPress();
      if (button.closeOnPress) {
        dismiss(entry.id);
        closed = true;
      }
    } catch {
      // Stay open on error.
    } finally {
      busy = false;
      if (!closed) markLoading(entry.id, index, false);
    }
  }

  function markLoading(id: string, index: number, loading: boolean) {
    const next = entries.map((e) => {
      if (e.id !== id) return e;
      return {
        ...e,
        buttons: e.buttons.map((b, i) => (i === index ? { ...b, loading } : b)),
      };
    });
    setEntries(next);
  }

  // Hosts call runButton via a side channel exposed only through the controller.
  // We attach it as a non-enumerable method on the returned object.

  const controller: DialogController = {
    get entries() {
      return entries;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showDialog: open,
    showInfo({ title, description }) {
      return open({ title: title ?? 'Info', description, buttons: [{ label: 'OK', variant: 'primary' }] });
    },
    showSuccess({ title, description }) {
      return open({ title: title ?? 'Success', description, buttons: [{ label: 'OK', variant: 'primary' }] });
    },
    showError({ title, description }) {
      return open({ title: title ?? 'Error', description, buttons: [{ label: 'OK', variant: 'primary' }] });
    },
    showConfirm({ title, description, confirmLabel, cancelLabel, destructive, onConfirm }) {
      return open({
        title,
        description,
        buttons: [
          { label: cancelLabel ?? 'Cancel', variant: 'secondary', onPress: () => {} },
          {
            label: confirmLabel ?? (destructive ? 'Delete' : 'Confirm'),
            variant: destructive ? 'danger' : 'primary',
            onPress: onConfirm,
          },
        ],
      });
    },
    dismiss,
    dismissAll() {
      setEntries([]);
    },
  };

  // Attach the button-runner side channel used by host renderers.
  (controller as unknown as { runButton: typeof runButton }).runButton = runButton;

  return controller;
}

/** Host-side helper to trigger a button's action on a controller. */
export function pressDialogButton(controller: DialogController, entry: DialogEntry, index: number) {
  const run = (controller as unknown as { runButton?: (e: DialogEntry, i: number) => Promise<void> }).runButton;
  if (run) void run(entry, index);
}
