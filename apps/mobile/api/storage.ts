import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const isWeb = Platform.OS === 'web';

const KEY_ACCESS = 'tvwatch.access';
const KEY_REFRESH = 'tvwatch.refresh';
const KEY_USER = 'tvwatch.user';
const KEY_API_URL = 'tvwatch.apiUrl';
const KEY_SELF_HOSTED = 'tvwatch.selfHosted';
const KEY_IMPORT_POPUP = 'tvwatch.importPopupShown';
const KEY_DISCORD_NEVER = 'tvwatch.discordNever';
const KEY_DISCORD_LAST = 'tvwatch.discordLastShown';

async function getItem(key: string): Promise<string | null> {
  if (isWeb) return localStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) { localStorage.setItem(key, value); return; }
  await SecureStore.setItemAsync(key, value);
}

async function deleteItem(key: string): Promise<void> {
  if (isWeb) { localStorage.removeItem(key); return; }
  await SecureStore.deleteItemAsync(key);
}

export const tokenStorage = {
  async getAccess() { return getItem(KEY_ACCESS); },
  async getRefresh() { return getItem(KEY_REFRESH); },
  async set(access: string, refresh: string) { await setItem(KEY_ACCESS, access); await setItem(KEY_REFRESH, refresh); },
  async clear() { await deleteItem(KEY_ACCESS); await deleteItem(KEY_REFRESH); await deleteItem(KEY_USER); },
  async setUser(user: unknown) { await setItem(KEY_USER, JSON.stringify(user)); },
  async getUser<T>(): Promise<T | null> { const raw = await getItem(KEY_USER); return raw ? (JSON.parse(raw) as T) : null; },
  async getApiUrl(): Promise<string | null> { return getItem(KEY_API_URL); },
  async setApiUrl(url: string) { await setItem(KEY_API_URL, url); },
  async getIsSelfHosted(): Promise<boolean> { return (await getItem(KEY_SELF_HOSTED)) === 'true'; },
  async setIsSelfHosted(val: boolean) { await setItem(KEY_SELF_HOSTED, val ? 'true' : 'false'); },
  async clearBackend() { await deleteItem(KEY_API_URL); await deleteItem(KEY_SELF_HOSTED); },
  async getImportPopupShown(): Promise<boolean> { return (await getItem(KEY_IMPORT_POPUP)) === 'true'; },
  async setImportPopupShown() { await setItem(KEY_IMPORT_POPUP, 'true'); },
  async getDiscordNeverShow(): Promise<boolean> { return (await getItem(KEY_DISCORD_NEVER)) === 'true'; },
  async setDiscordNeverShow() { await setItem(KEY_DISCORD_NEVER, 'true'); },
  async getDiscordLastShown(): Promise<number | null> { const v = await getItem(KEY_DISCORD_LAST); return v ? parseInt(v, 10) : null; },
  async setDiscordLastShown(ts: number) { await setItem(KEY_DISCORD_LAST, String(ts)); },
};
