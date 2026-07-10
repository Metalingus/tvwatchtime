// Compat shim — legacy showAlert() now routes to the themed dialog system.
// Prefer importing showDialog/showConfirm directly from '../lib/dialog'.

import { showDialog } from '../lib/dialog';

type AlertButton = {
  text: string;
  onPress?: () => void | Promise<void>;
  style?: 'default' | 'cancel' | 'destructive';
};

export function showAlert(title: string, message?: string, buttons?: AlertButton[]) {
  const cancel = buttons?.find((b) => b.style === 'cancel');
  const actions = buttons?.filter((b) => b.style !== 'cancel') ?? [];

  if (!buttons || buttons.length === 0 || actions.length === 0) {
    showDialog({
      title,
      description: message,
      buttons: [{ label: 'OK', variant: 'primary', onPress: buttons?.[0]?.onPress }],
    });
    return;
  }

  showDialog({
    title,
    description: message,
    buttons: [
      ...(cancel ? [{ label: cancel.text, variant: 'secondary' as const, onPress: cancel.onPress }] : []),
      ...actions.map((b) => ({
        label: b.text,
        variant: (b.style === 'destructive' ? 'danger' : 'primary') as 'danger' | 'primary',
        onPress: b.onPress,
      })),
    ],
  });
}
