// base64url (RFC 4648 §5, the `-_` alphabet, padding optional) → bytes.
// Web Push VAPID keys arrive in this form and the PushManager wants a
// Uint8Array. Browser-only — leans on atob.
export function base64UrlToBytes(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
