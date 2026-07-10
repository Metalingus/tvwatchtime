import { useEffect } from 'react';
import { Platform } from 'react-native';
import { api } from '../api/client';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = typeof atob !== 'undefined' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function useWebPush(enabled: boolean) {
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;

    let subscribed = false;

    (async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          subscribed = true;
          return;
        }

        const flags = await api.get<Record<string, any>>('/feature-flags');
        const publicKey = flags.vapid_public_key;
        if (!publicKey) return;

        const subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        const sub = subscription.toJSON();
        await api.post('/devices/register', {
          token: subscription.endpoint,
          platform: 'web',
          pushEndpoint: subscription.endpoint,
          pushP256dh: sub.keys?.p256dh,
          pushAuth: sub.keys?.auth,
        });
        subscribed = true;
      } catch (e) {
        // Push not available or denied — silently skip
      }
    })();

    return () => { subscribed = false; };
  }, [enabled]);
}
