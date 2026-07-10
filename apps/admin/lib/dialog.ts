import { createDialogController } from '@tvwatch/shared';
import type { DialogController } from '@tvwatch/shared';

/**
 * Single shared dialog controller instance for the admin app.
 * Imperative helpers are callable anywhere (event handlers, async catch blocks).
 */
export const dialog: DialogController = createDialogController();

export const showDialog = dialog.showDialog.bind(dialog);
export const showInfo = dialog.showInfo.bind(dialog);
export const showSuccess = dialog.showSuccess.bind(dialog);
export const showError = dialog.showError.bind(dialog);
export const showConfirm = dialog.showConfirm.bind(dialog);
export const dismissDialog = dialog.dismiss.bind(dialog);
export const dismissAllDialogs = dialog.dismissAll.bind(dialog);

/**
 * Hook form of the imperative API. Components can use this for ergonomics; the imperative
 * exports above are preferred inside event handlers and async callbacks.
 */
export function useDialog(): DialogController {
  return dialog;
}
