// Themed safety-net adapter for web: routes any residual React Native Alert.alert(...)
// (including calls from third-party libs) to the new custom dialog system instead of native
// browser window.alert/confirm/prompt. Imported once in _layout.tsx. Native platforms keep
// the real Alert (app code is migrated to the dialog system directly).

import { Platform, Alert, AlertButton } from 'react-native';
import { showDialog } from '../lib/dialog';
import type { DialogButton, DialogVariant } from '@tvwatch/shared';

if (Platform.OS === 'web') {
  Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
    const cancel = buttons?.find((b) => b.style === 'cancel');
    const actions = buttons?.filter((b) => b.style !== 'cancel') ?? [];

    const toDialogButton = (b: AlertButton): DialogButton => ({
      label: b.text ?? 'OK',
      variant: (b.style === 'destructive' ? 'danger' : 'primary') as DialogVariant,
      onPress: b.onPress ? () => b.onPress?.() : undefined,
    });

    if (!buttons || buttons.length === 0 || actions.length === 0) {
      showDialog({
        title,
        description: message,
        buttons: [{ label: 'OK', variant: 'primary', onPress: buttons?.[0]?.onPress ? () => buttons[0].onPress?.() : undefined }],
      });
      return;
    }

    showDialog({
      title,
      description: message,
      buttons: [
        ...(cancel ? [{ label: cancel.text ?? 'Cancel', variant: 'secondary' as DialogVariant, onPress: cancel.onPress ? () => cancel.onPress?.() : undefined }] : []),
        ...actions.map(toDialogButton),
      ],
    });
  };
}

export {};
