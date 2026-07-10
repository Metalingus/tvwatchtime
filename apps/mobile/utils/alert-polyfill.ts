// Alert polyfill for web — maps Alert.alert() to window.alert()/window.confirm()
// Imported once in _layout.tsx, patches Alert.alert globally on web

import { Platform, Alert, AlertButton } from 'react-native';

if (Platform.OS === 'web') {
  const originalAlert = Alert.alert;

  Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
    const text = message ? `${title}\n\n${message}` : title;

    if (!buttons || buttons.length <= 1) {
      // Single button or no buttons → simple alert
      window.alert(text);
      buttons?.[0]?.onPress?.();
      return;
    }

    // Multiple buttons → use confirm for 2, prompt for 3+
    if (buttons.length === 2) {
      // First button = cancel, last button = action
      const confirmed = window.confirm(text);
      if (confirmed) {
        buttons[buttons.length - 1]?.onPress?.();
      } else {
        buttons[0]?.onPress?.();
      }
      return;
    }

    // 3+ buttons → prompt with numbered options
    const options = buttons
      .filter((b) => b.text !== 'Cancel')
      .map((b, i) => `${i + 1}. ${b.text}`)
      .join('\n');
    const cancelBtn = buttons.find((b) => b.style === 'cancel');
    const choice = window.prompt(`${text}\n\n${options}\n\nEnter a number:`, '1');

    if (!choice) {
      cancelBtn?.onPress?.();
      return;
    }

    const idx = parseInt(choice, 10) - 1;
    const actionButtons = buttons.filter((b) => b.style !== 'cancel');
    if (idx >= 0 && idx < actionButtons.length) {
      actionButtons[idx]?.onPress?.();
    } else {
      cancelBtn?.onPress?.();
    }
  };
}

export {};
