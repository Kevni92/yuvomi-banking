/* Banking owns this narrowly scoped worker; it never replaces Yuvomi's app-shell worker. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title
    ? payload.title
    : 'Yuvomi Banking';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag: typeof payload.tag === 'string' ? payload.tag : 'banking-notification',
    data: { url: typeof payload.url === 'string' ? payload.url : '/m/banking' }
  };
  if (typeof payload.image === 'string' && payload.image.startsWith('/')) {
    options.image = payload.image;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = typeof event.notification.data?.url === 'string'
    ? event.notification.data.url
    : '/m/banking';
  event.waitUntil((async () => {
    const targetUrl = new URL(target, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const windowClient of windows) {
      if (new URL(windowClient.url).origin === self.location.origin) {
        await windowClient.focus();
        if ('navigate' in windowClient) await windowClient.navigate(targetUrl);
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
