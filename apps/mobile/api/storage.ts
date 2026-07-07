import * as SecureStore from 'expo-secure-store';

const KEY_ACCESS = 'tvwatch.access';
const KEY_REFRESH = 'tvwatch.refresh';
const KEY_USER = 'tvwatch.user';
const KEY_API_URL = 'tvwatch.apiUrl';
const KEY_SELF_HOSTED = 'tvwatch.selfHosted';

export const tokenStorage = {
  async getAccess() {
    return (await SecureStore.getItemAsync(KEY_ACCESS)) ?? null;
  },
  async getRefresh() {
    return (await SecureStore.getItemAsync(KEY_REFRESH)) ?? null;
  },
  async set(access: string, refresh: string) {
    await SecureStore.setItemAsync(KEY_ACCESS, access);
    await SecureStore.setItemAsync(KEY_REFRESH, refresh);
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY_ACCESS);
    await SecureStore.deleteItemAsync(KEY_REFRESH);
    await SecureStore.deleteItemAsync(KEY_USER);
  },
  async setUser(user: unknown) {
    await SecureStore.setItemAsync(KEY_USER, JSON.stringify(user));
  },
  async getUser<T>(): Promise<T | null> {
    const raw = await SecureStore.getItemAsync(KEY_USER);
    return raw ? (JSON.parse(raw) as T) : null;
  },
  async getApiUrl(): Promise<string | null> {
    return (await SecureStore.getItemAsync(KEY_API_URL)) ?? null;
  },
  async setApiUrl(url: string) {
    await SecureStore.setItemAsync(KEY_API_URL, url);
  },
  async getIsSelfHosted(): Promise<boolean> {
    return (await SecureStore.getItemAsync(KEY_SELF_HOSTED)) === 'true';
  },
  async setIsSelfHosted(val: boolean) {
    await SecureStore.setItemAsync(KEY_SELF_HOSTED, val ? 'true' : 'false');
  },
  async clearBackend() {
    await SecureStore.deleteItemAsync(KEY_API_URL);
    await SecureStore.deleteItemAsync(KEY_SELF_HOSTED);
  },
};
