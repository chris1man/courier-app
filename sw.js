self.addEventListener('install', (event) => {
  console.log('Service Worker установлен');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker активирован');
  event.waitUntil(self.clients.claim());
});

let ws;
let tags;

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(`wss://makiapp.ru/ws?tags=${tags.join(',')}`);

  ws.onopen = () => {
    console.log('Service Worker WebSocket подключён');
    sendLocation();
    setInterval(sendLocation, 10000); // Отправка каждые 10 секунд
  };

  ws.onclose = () => {
    console.log('Service Worker WebSocket отключён');
    setTimeout(connectWebSocket, 1000);
  };

  ws.onerror = (error) => console.error('Ошибка WebSocket в Service Worker:', error);
}

function sendLocation() {
  if (navigator.geolocation && ws.readyState === WebSocket.OPEN) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        ws.send(JSON.stringify({
          type: 'location',
          data: { tags, lat: latitude, lng: longitude }
        }));
        console.log('Service Worker отправил координаты:', { lat: latitude, lng: longitude });
      },
      (error) => console.error('Ошибка геолокации в Service Worker:', error),
      { enableHighAccuracy: true }
    );
  }
}

self.addEventListener('message', (event) => {
  if (event.data.type === 'init') {
    tags = event.data.tags;
    connectWebSocket();
  }
});