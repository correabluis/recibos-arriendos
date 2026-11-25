// Solo permite instalar el formulario como aplicación. No guarda copias: siempre carga la versión vigente.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
