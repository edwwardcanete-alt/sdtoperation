// Minimal service worker - just unregister itself
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
// Do NOT intercept any fetch requests - let everything through
