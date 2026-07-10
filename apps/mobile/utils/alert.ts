import { Alert, Platform } from 'react-native';

type AlertButton = { text: string; onPress?: () => void; style?: 'default' | 'cancel' | 'destructive' };

export function showAlert(title: string, message?: string, buttons?: AlertButton[]) {
  if (Platform.OS === 'web') {
    if (!buttons || buttons.length === 0) {
      window.alert(message ? `${title}\n\n${message}` : title);
      return;
    }
    // Simple web confirm — first button is cancel, last is confirm
    if (buttons.length === 2) {
      if (window.confirm(message ? `${title}\n\n${message}` : title)) {
        buttons[1]?.onPress?.();
      } else {
        buttons[0]?.onPress?.();
      }
      return;
    }
    // Single button
    window.alert(message ? `${title}\n\n${message}` : title);
    buttons[0]?.onPress?.();
    return;
  }
  Alert.alert(title, message, buttons);
}
