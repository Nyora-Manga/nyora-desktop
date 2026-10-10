// The prototype must never read an existing browser session or contact sync.
export const SYNC_CONFIG = Object.freeze({ syncUrl: '' });
export function status() {
  return { isConfigured: false, isAuthenticated: false, userId: '', email: '', lastSyncTimestamp: '' };
}
export function hasLocalData() { return false; }
const disabled = async () => { throw new Error('Cloud sync is disabled in the desktop prototype.'); };
export const register = disabled;
export const signIn = disabled;
export const registerAndMigrate = disabled;
export const signInAndFetch = disabled;
export const syncNow = disabled;
export const restoreFromCloud = disabled;
export function signOut() {}
export default { status, hasLocalData, register, signIn, registerAndMigrate, signInAndFetch, syncNow, restoreFromCloud, signOut };
