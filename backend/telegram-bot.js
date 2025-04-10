const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const { TELEGRAM_TOKEN, SERVER_URL, COURIER_MAPPING_PATH, LIVE_UPDATE_INTERVAL } = require('./config');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let courierMapping;
try {
  courierMapping = JSON.parse(fs.readFileSync(COURIER_MAPPING_PATH, 'utf8'));
  console.log('Загружены данные курьеров:', courierMapping);
} catch (error) {
  console.error('Ошибка загрузки courier-mapping.json:', error.message);
  courierMapping = {};
}

const activeLiveLocations = new Map(); // chatId -> { login, lastUpdate }

const sendLocationUpdate = async (chatId, latitude, longitude) => {
  const login = courierMapping[chatId];
  if (!login) return;

  try {
    const response = await axios.post(`${SERVER_URL}/api/location`, {
      login,
      lat: latitude,
      lng: longitude,
      live: true
    });
    console.log(`Отправлены координаты для ${login}: ${latitude}, ${longitude}, ответ: ${response.status} - ${response.data.message}`);
    activeLiveLocations.set(chatId, { login, lastUpdate: Date.now() });
  } catch (error) {
    console.error('Ошибка отправки координат:', error.message);
  }
};

bot.on('location', async (msg) => {
  const chatId = msg.chat.id.toString();
  const { latitude, longitude, live_period } = msg.location;
  const login = courierMapping[chatId];

  console.log(`Получено местоположение от chatId: ${chatId}, login: ${login || 'не найден'}, live_period: ${live_period || 'нет'}`);

  if (!login) {
    bot.sendMessage(chatId, 'Вы не зарегистрированы как курьер. Обратитесь к администратору.');
    return;
  }

  if (!live_period) {
    console.log(`Обычное местоположение от ${login}, игнорируем`);
    bot.sendMessage(chatId, 'Пожалуйста, отправьте "живое" местоположение:\n1. Нажмите кнопку ниже.\n2. Выберите "Делиться 8 часов".');
    return;
  }

  if (!activeLiveLocations.has(chatId)) {
    console.log(`Новое live местоположение от ${login}, live_period: ${live_period}`);
    bot.sendMessage(chatId, 'Спасибо, что поделились "живым" местоположением! Теперь оно будет обновляться автоматически.');
  }

  await sendLocationUpdate(chatId, latitude, longitude);
});

bot.on('edited_message', async (msg) => {
  if (msg.location) {
    const chatId = msg.chat.id.toString();
    const { latitude, longitude } = msg.location;
    console.log(`Обновление live координат для chatId ${chatId}: ${latitude}, ${longitude}`);
    await sendLocationUpdate(chatId, latitude, longitude);
  }
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Нажмите кнопку ниже и выберите "Делиться 8 часов", чтобы начать live-трансляцию местоположения:', {
    reply_markup: {
      keyboard: [[{ text: 'Поделиться live-местоположением', request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [chatId, { login, lastUpdate }] of activeLiveLocations) {
    const timeSinceUpdate = now - lastUpdate;
    console.log(`Проверка активности для ${login} (chatId: ${chatId}): ${timeSinceUpdate / 1000} сек с последнего обновления`);
    if (timeSinceUpdate > LIVE_UPDATE_INTERVAL) {
      console.log(`Live-сессия для ${login} (chatId: ${chatId}) неактивна`);
      activeLiveLocations.delete(chatId);
      axios.post(`${SERVER_URL}/api/location`, { login, live: false })
        .then(() => console.log(`Сессия ${login} завершена на сервере`))
        .catch(err => console.error(`Ошибка завершения сессии ${login}:`, err.message));
      bot.sendMessage(chatId, 'Ваше "живое" местоположение больше не активно. Нажмите кнопку ниже и выберите "Делиться 8 часов", чтобы продолжить:', {
        reply_markup: {
          keyboard: [[{ text: 'Поделиться live-местоположением', request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    }
  }
}, 30000);

console.log('Telegram-бот запущен');