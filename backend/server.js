require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const cron = require('node-cron');
const { LIVE_UPDATE_INTERVAL, MAP_DISPLAY_EXTENSION } = require('./config');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.path === '/map') {
    res.set('Content-Type', 'text/html');
    return res.sendFile(path.join(__dirname, 'public', 'map.html'));
  }
  express.static(path.join(__dirname, 'public'))(req, res, next);
});

const AMOCRM_DOMAIN = process.env.AMOCRM_DOMAIN;
const API_TOKEN = process.env.API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || 'default_secret';
const PORT = process.env.PORT || 3001;
const REQUEST_DELAY = 1000;
const QUEUE_DELAY = 5000;
const CACHE_DURATION = 5 * 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 30;

const couriersFilePath = path.join(__dirname, 'couriers.json');
let couriers;
try {
  couriers = JSON.parse(fs.readFileSync(couriersFilePath, 'utf8'));
} catch (error) {
  console.error('Ошибка загрузки файла couriers.json:', error.message);
  couriers = {};
}

const ordersFilePath = path.join(__dirname, 'orders.json');
let ordersByCourier;
try {
  ordersByCourier = JSON.parse(fs.readFileSync(ordersFilePath, 'utf8'));
} catch (error) {
  console.error('Ошибка загрузки файла orders.json:', error.message);
  ordersByCourier = {};
}

const saveOrdersToFile = () => {
  try {
    fs.writeFileSync(ordersFilePath, JSON.stringify(ordersByCourier, null, 2));
    console.log('Заказы сохранены в orders.json');
  } catch (error) {
    console.error('Ошибка сохранения заказов в файл:', error.message);
  }
};

const clientsByLogin = {};
const courierLocations = {};
const webhookQueue = {};

const courierColors = {
  "danil": "#FF0000",
  "katya": "#0000FF",
  "sasha": "#008000",
  "pasha": "#FFA500",
  "timur": "#800080",
  "vladimir": "#8B0000",
  "alex": "#00008B",
  "testcourier": "#00FFFF"
};

const apiCache = {
  data: new Map(),
  lastRequest: 0,
  requestCount: 0,
  lastReset: Date.now()
};

function checkRequestLimit() {
  const now = Date.now();
  if (now - apiCache.lastReset >= 60000) {
    apiCache.requestCount = 0;
    apiCache.lastReset = now;
  }
  
  if (apiCache.requestCount >= MAX_REQUESTS_PER_MINUTE) {
    const waitTime = 60000 - (now - apiCache.lastReset);
    console.log(`Достигнут лимит запросов. Ожидание ${waitTime}мс`);
    return false;
  }
  
  apiCache.requestCount++;
  return true;
}

async function fetchFromAmoCRM(params) {
  const cacheKey = JSON.stringify(params);
  const cachedData = apiCache.data.get(cacheKey);
  
  if (cachedData && Date.now() - cachedData.timestamp < CACHE_DURATION) {
    console.log('Возвращаем данные из кэша');
    return cachedData.data;
  }
  
  if (!checkRequestLimit()) {
    if (cachedData) {
      console.log('Используем устаревшие данные из кэша из-за ограничения запросов');
      return cachedData.data;
    }
    throw new Error('Превышен лимит запросов к API');
  }
  
  const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    params: params
  });
  
  apiCache.data.set(cacheKey, {
    data: response.data,
    timestamp: Date.now()
  });
  
  return response.data;
}

async function fetchAllLeads(tags, pipelineId, statusId) {
  const allLeads = [];
  let page = 1;
  const limit = 10;

  while (true) {
    try {
      console.log(`Запрос заказов для тегов ${tags}, страница ${page}`);
      const response = await fetchFromAmoCRM({
        with: 'contacts',
        filter: { statuses: [{ pipeline_id: pipelineId, status_id: statusId }], tags: tags },
        limit: limit,
        page: page
      });
      
      console.log('Ответ от amoCRM:', {
        total: response._total,
        page: page,
        leads: response._embedded.leads.map(lead => ({
          id: lead.id,
          tags: lead._embedded.tags.map(t => t.name)
        }))
      });
      
      const leads = response._embedded.leads || [];
      const filteredLeads = leads.filter(lead => {
        const leadTags = lead._embedded.tags.map(t => t.name);
        const hasMatchingTag = leadTags.some(t => tags.includes(t));
        console.log(`Проверка заказа ${lead.id}:`, {
          leadTags,
          searchTags: tags,
          hasMatch: hasMatchingTag
        });
        return hasMatchingTag;
      });
      
      allLeads.push(...filteredLeads);

      if (leads.length < limit) break;
      page++;
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    } catch (error) {
      console.error('Ошибка при получении заказов:', error.message);
      break;
    }
  }

  return allLeads;
}

wss.on('connection', (ws, req) => {
  console.log('Новое WebSocket-соединение:', req.url);
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const login = urlParams.get('login');
  const isMap = urlParams.get('type') === 'map';

  if (isMap) {
    ws.on('message', (message) => {
      const msgString = message.toString();
      if (msgString === 'ping') {
        ws.send('pong');
        return;
      }
    });
    ws.send(JSON.stringify({ type: 'locations', data: courierLocations }));
    ws.send(JSON.stringify({ 
      type: 'couriers', 
      data: Object.keys(couriers).map(name => ({
        name,
        color: courierColors[name] || '#808080'
      }))
    }));
  } else if (login) {
    const normalizedLogin = login.toLowerCase();
    clientsByLogin[normalizedLogin] = clientsByLogin[normalizedLogin] || [];
    clientsByLogin[normalizedLogin].push(ws);
    console.log(`Курьер подключился с логином ${normalizedLogin} через WebSocket`);

    const courierData = couriers[normalizedLogin];
    let tags = [];
    if (courierData) {
      if (courierData.tags) {
        tags = courierData.tags;
      } else if (courierData.tag) {
        tags = [courierData.tag];
      } else {
        tags = [normalizedLogin];
      }
    } else {
      tags = [normalizedLogin];
    }
    console.log(`Теги для ${normalizedLogin}:`, tags);

    const allOrders = tags.flatMap(tag => ordersByCourier[tag] || []);
    const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
    ws.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
    ws.send(JSON.stringify({ type: 'locations', data: courierLocations }));
    ws.send(JSON.stringify({ 
      type: 'couriers', 
      data: Object.keys(couriers).map(name => ({
        name,
        color: courierColors[name] || '#808080'
      }))
    }));

    ws.on('message', (message) => {
      const msgString = message.toString();
      if (msgString === 'ping') {
        ws.send('pong');
        return;
      }
    });

    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
    ws.on('close', () => {
      clientsByLogin[normalizedLogin] = clientsByLogin[normalizedLogin].filter(client => client !== ws);
      console.log(`Курьер с логином ${normalizedLogin} отключился`);
    });
  } else {
    ws.close();
  }
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const courier = couriers[login];
  if (courier && courier.password === password) {
    const tags = courier.tags || [login];
    res.json({ success: true, login, tags });
  } else {
    res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
  }
});

app.get('/api/leads', (req, res) => {
  const { tag } = req.query;
  let tags = tag ? tag.split(',') : [];
  
  // Если передан логин вместо тега, используем теги из couriers.json
  if (tags.length === 1 && couriers[tags[0]]) {
    tags = couriers[tags[0]].tags || [tags[0]];
    console.log(`Замена логина ${tags[0]} на теги:`, tags);
  }
  
  const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
  const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
  res.json({ _embedded: { leads: uniqueOrders } });
});

app.get('/api/contacts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/contacts/${id}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` }
    });
    const phoneField = response.data.custom_fields_values?.find(field => field.field_type === 'phone');
    const phone = phoneField?.values[0]?.value || 'Не указан';
    res.json({ phone });
  } catch (error) {
    console.error('Ошибка получения телефона контакта:', error.message);
    res.status(500).json({ error: 'Не удалось получить данные контакта' });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  console.log('Запрос на /api/leads/:id (PATCH):', req.params, req.body);
  const { id } = req.params;
  const { status_id } = req.body;

  try {
    let orderExists = false;
    for (const tag in ordersByCourier) {
      if (ordersByCourier[tag].some(order => order.id === parseInt(id))) {
        orderExists = true;
        break;
      }
    }
    if (!orderExists) throw new Error('Заказ не найден в списке курьера');

    const response = await axios.patch(
      `https://${AMOCRM_DOMAIN}/api/v4/leads/${id}`,
      { status_id: parseInt(status_id) },
      { headers: { Authorization: `Bearer ${API_TOKEN}` } }
    );
    console.log('Ответ от amoCRM:', response.data);

    for (const tag in ordersByCourier) {
      const initialLength = ordersByCourier[tag].length;
      ordersByCourier[tag] = ordersByCourier[tag].filter(lead => lead.id !== parseInt(id));
      if (ordersByCourier[tag].length < initialLength) {
        console.log(`Заказ ${id} удалён из ordersByCourier для тега ${tag}`);
        saveOrdersToFile();
        if (clientsByLogin[tag]) {
          clientsByLogin[tag].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
              console.log(`Отправлен обновлённый список заказов для логина ${tag}`);
            }
          });
        }
        delete courierLocations[tag];
        wss.clients.forEach(client => {
          const clientParams = new URLSearchParams(client.url?.split('?')[1] || '');
          if (client.readyState === WebSocket.OPEN && clientParams.get('type') === 'map') {
            client.send(JSON.stringify({ type: 'locations', data: courierLocations }));
          }
        });
      }
    }

    res.json(response.data);
  } catch (error) {
    console.error('Ошибка PATCH-запроса:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

app.get('/api/webhook/:courier', (req, res) => {
  const { courier } = req.params;
  if (couriers[courier]) {
    res.status(200).json({ message: 'Webhook доступен' });
  } else {
    res.status(400).json({ error: 'Курьер не найден' });
  }
});

app.post('/api/webhook/:courier', async (req, res) => {
  const { courier } = req.params;
  const courierData = couriers[courier];
  if (!courierData) {
    return res.status(400).json({ error: 'Курьер не найден' });
  }
  
  let tags = [];
  if (courierData.tags) {
    tags = courierData.tags;
  } else if (courierData.tag) {
    tags = [courierData.tag];
  } else {
    tags = [courier];
  }
  console.log(`Обработка вебхука для ${courier}, теги:`, tags);

  try {
    webhookQueue[courier] = (webhookQueue[courier] || 0) + 1;
    console.log(`Получен вебхук для ${courier}, всего: ${webhookQueue[courier]}`);

    const response = await fetchFromAmoCRM({
      with: 'contacts',
      filter: { statuses: [{ pipeline_id: 4963870, status_id: 54415026 }], tags: tags },
      limit: 10
    });

    let newLeads = response._embedded.leads.filter(lead => {
      const leadTags = lead._embedded.tags.map(t => t.name);
      const hasMatchingTag = leadTags.some(t => tags.includes(t));
      console.log(`Проверка заказа ${lead.id} в вебхуке:`, {
        leadTags,
        searchTags: tags,
        hasMatch: hasMatchingTag
      });
      return hasMatchingTag;
    });

    for (const lead of newLeads) {
      const contactId = lead._embedded?.contacts?.[0]?.id;
      if (contactId) {
        const contactResponse = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/contacts/${contactId}`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` }
        });
        const phoneField = contactResponse.data.custom_fields_values?.find(field => field.field_type === 'phone');
        const workPhoneField = contactResponse.data.custom_fields_values?.find(field => field.field_id === 289537);
        lead.contact = {
          id: contactId,
          name: contactResponse.data.name || 'Не указано',
          phone: workPhoneField?.values.find(val => val.enum_code === 'WORK')?.value || phoneField?.values[0]?.value || 'Не указан'
        };
      } else {
        lead.contact = { id: null, name: 'Не указано', phone: 'Не указан' };
      }
    }

    tags.forEach(tag => {
      ordersByCourier[tag] = ordersByCourier[tag] || [];
      newLeads.forEach(newLead => {
        const existingIndex = ordersByCourier[tag].findIndex(existing => existing.id === newLead.id);
        if (existingIndex === -1) {
          ordersByCourier[tag].push(newLead);
        } else {
          ordersByCourier[tag][existingIndex] = newLead;
        }
      });
    });

    saveOrdersToFile();

    tags.forEach(tag => {
      if (clientsByLogin[tag]) {
        clientsByLogin[tag].forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
            const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
            client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
          }
        });
      }
    });

    if (webhookQueue[courier] > 5) {
      console.log(`Очередь для ${courier}: запрашиваем все заказы через ${QUEUE_DELAY / 1000} секунд`);
      setTimeout(async () => {
        const allLeads = await fetchAllLeads(tags, 4963870, 54415026);
        for (const lead of allLeads) {
          const contactId = lead._embedded?.contacts?.[0]?.id;
          if (contactId) {
            const contactResponse = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/contacts/${contactId}`, {
              headers: { Authorization: `Bearer ${API_TOKEN}` }
            });
            const phoneField = contactResponse.data.custom_fields_values?.find(field => field.field_type === 'phone');
            const workPhoneField = contactResponse.data.custom_fields_values?.find(field => field.field_id === 289537);
            lead.contact = {
              id: contactId,
              name: contactResponse.data.name || 'Не указано',
              phone: workPhoneField?.values.find(val => val.enum_code === 'WORK')?.value || phoneField?.values[0]?.value || 'Не указан'
            };
          } else {
            lead.contact = { id: null, name: 'Не указано', phone: 'Не указан' };
          }
        }

        tags.forEach(tag => {
          ordersByCourier[tag] = ordersByCourier[tag] || [];
          allLeads.forEach(newLead => {
            const existingIndex = ordersByCourier[tag].findIndex(existing => existing.id === newLead.id);
            if (existingIndex === -1) {
              ordersByCourier[tag].push(newLead);
            } else {
              ordersByCourier[tag][existingIndex] = newLead;
            }
          });
        });

        saveOrdersToFile();

        tags.forEach(tag => {
          if (clientsByLogin[tag]) {
            clientsByLogin[tag].forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
                const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
                client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
              }
            });
          }
        });

        webhookQueue[courier] = 0;
        console.log(`Все заказы для ${courier} обработаны из очереди`);
      }, QUEUE_DELAY);
    }

    res.status(200).json({ message: 'Webhook обработан' });
  } catch (error) {
    console.error(`Ошибка вебхука для ${courier}:`, error.message);
    res.status(500).json({ error: 'Ошибка обработки вебхука' });
  }
});

app.post('/api/location', (req, res) => {
  const { login, lat, lng, live } = req.body;

  if (!login) {
    console.error('Неверные параметры в /api/location:', req.body);
    return res.status(400).json({ error: 'Логин обязателен' });
  }

  const normalizedLogin = login.toLowerCase();

  if (live === false) {
    console.log(`Live-сессия для ${normalizedLogin} завершена для приложения`);
    if (courierLocations[normalizedLogin]) {
      courierLocations[normalizedLogin].live = false;
    }
  } else if (lat && lng) {
    courierLocations[normalizedLogin] = { lat, lng, lastUpdate: Date.now(), live: true };
    console.log(`Получены live координаты для ${normalizedLogin}: ${lat}, ${lng}`);
  } else {
    console.error('Неверные координаты в /api/location:', req.body);
    return res.status(400).json({ error: 'Координаты lat и lng обязательны для live' });
  }

  wss.clients.forEach(client => {
    const clientParams = new URLSearchParams(client.url?.split('?')[1] || '');
    const clientLogin = clientParams.get('login') || (clientParams.get('type') === 'map' ? 'map' : 'unknown');
    if (client.readyState === WebSocket.OPEN) {
      console.log(`Отправка WebSocket клиенту с логином/типом: ${clientLogin}`);
      client.send(JSON.stringify({ type: 'locations', data: courierLocations }));
      if (clientParams.get('type') === 'map') {
        client.send(JSON.stringify({ 
          type: 'couriers', 
          data: Object.keys(couriers).map(name => ({
            name,
            color: courierColors[name] || '#808080'
          }))
        }));
      }
    }
  });

  res.status(200).json({ message: 'Координаты приняты' });
});

app.delete('/api/leads/:id', (req, res) => {
  console.log('Запрос на /api/leads/:id (DELETE):', req.params);
  const { id } = req.params;

  try {
    let orderExists = false;
    for (const tag in ordersByCourier) {
      if (ordersByCourier[tag].some(order => order.id === parseInt(id))) {
        orderExists = true;
        break;
      }
    }
    if (!orderExists) throw new Error('Заказ не найден в списке курьера');

    for (const tag in ordersByCourier) {
      const initialLength = ordersByCourier[tag].length;
      ordersByCourier[tag] = ordersByCourier[tag].filter(lead => lead.id !== parseInt(id));
      if (ordersByCourier[tag].length < initialLength) {
        console.log(`Заказ ${id} удалён из ordersByCourier для тега ${tag}`);
        saveOrdersToFile();
        if (clientsByLogin[tag]) {
          clientsByLogin[tag].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
              console.log(`Отправлен обновлённый список заказов для логина ${tag}`);
            }
          });
        }
        delete courierLocations[tag];
        wss.clients.forEach(client => {
          const clientParams = new URLSearchParams(client.url?.split('?')[1] || '');
          if (client.readyState === WebSocket.OPEN && clientParams.get('type') === 'map') {
            client.send(JSON.stringify({ type: 'locations', data: courierLocations }));
          }
        });
      }
    }

    res.status(200).json({ message: `Заказ ${id} удалён из списка` });
  } catch (error) {
    console.error('Ошибка при удалении заказа:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders/sort', (req, res) => {
  const { tags, orderIds } = req.body;
  if (!tags || !orderIds || !Array.isArray(tags) || !Array.isArray(orderIds)) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }

  tags.forEach(tag => {
    if (!ordersByCourier[tag]) return;
    const currentOrders = ordersByCourier[tag];
    const sortedOrders = orderIds
      .map(id => currentOrders.find(order => order.id === id))
      .filter(order => order !== undefined);
    ordersByCourier[tag] = sortedOrders;
    console.log(`Порядок заказов обновлён для тега ${tag}`);

    if (clientsByLogin[tag]) {
      clientsByLogin[tag].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'orders', data: sortedOrders }));
        }
      });
    }
  });

  saveOrdersToFile();
  res.status(200).json({ message: 'Порядок заказов сохранён' });
});

app.get('/api/courier-orders/:login', (req, res) => {
  const { login } = req.params;
  const normalizedLogin = login.toLowerCase();
  console.log(`Запрос заказов для логина: ${normalizedLogin}`);

  const tags = couriers[normalizedLogin]?.tags || [normalizedLogin];
  const allOrders = tags.flatMap(tag => ordersByCourier[tag] || []);
  const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());

  if (!uniqueOrders.length) {
    console.log(`Заказы для ${normalizedLogin} не найдены`);
    return res.status(200).json({ orders: [] });
  }

  const activeOrders = uniqueOrders.map(order => ({
    id: order.id,
    address: order.custom_fields_values?.find(f => f.field_id === 293241)?.values[0]?.value || 'Не указан',
    deliveryTime: order.custom_fields_values?.find(f => f.field_id === 293299)?.values[0]?.value || 'Не указано'
  }));

  console.log(`Отправлены заказы для ${normalizedLogin}:`, activeOrders);
  res.status(200).json({ orders: activeOrders });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const checkOrdersValidity = async () => {
  console.log('Начало проверки актуальности заказов');
  try {
    const courierList = Object.keys(couriers);
    for (let i = 0; i < courierList.length; i++) {
      const courier = courierList[i];
      const tags = couriers[courier].tags || [courier];
      const allLeads = await fetchAllLeads(tags, 4963870, 54415026);
      const actualLeadIds = new Set(allLeads.map(lead => lead.id));

      tags.forEach(tag => {
        if (!ordersByCourier[tag]) return;
        const initialLength = ordersByCourier[tag].length;
        ordersByCourier[tag] = ordersByCourier[tag].filter(lead => actualLeadIds.has(lead.id));
        if (ordersByCourier[tag].length < initialLength) {
          saveOrdersToFile();
          if (clientsByLogin[tag]) {
            clientsByLogin[tag].forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
                const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
                client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
              }
            });
          }
          delete courierLocations[tag];
          wss.clients.forEach(client => {
            const clientParams = new URLSearchParams(client.url?.split('?')[1] || '');
            if (client.readyState === WebSocket.OPEN && clientParams.get('type') === 'map') {
              client.send(JSON.stringify({ type: 'locations', data: courierLocations }));
            }
          });
        }
      });

      if (i < courierList.length - 1) await delay(REQUEST_DELAY);
    }
    console.log('Проверка актуальности заказов завершена');
  } catch (error) {
    console.error('Ошибка при проверке актуальности заказов:', error.message);
  }
};

// Проверка устаревших местоположений для карты
setInterval(() => {
  const now = Date.now();
  for (const login in courierLocations) {
    const { lastUpdate } = courierLocations[login];
    const timeSinceUpdate = now - lastUpdate;
    if (timeSinceUpdate > LIVE_UPDATE_INTERVAL + MAP_DISPLAY_EXTENSION) {
      console.log(`Локация ${login} устарела более чем на 12 минут, удаляем с карты`);
      delete courierLocations[login];
      wss.clients.forEach(client => {
        const clientParams = new URLSearchParams(client.url?.split('?')[1] || '');
        if (client.readyState === WebSocket.OPEN && clientParams.get('type') === 'map') {
          client.send(JSON.stringify({ type: 'locations', data: courierLocations }));
        }
      });
    }
  }
}, 30000);

app.get('/cron', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cron.html'));
});

app.post('/cron', (req, res) => {
  const { secret } = req.body;
  if (secret === CRON_SECRET) {
    checkOrdersValidity();
    res.redirect('/cron?status=success');
  } else {
    res.redirect('/cron?status=error');
  }
});

cron.schedule('5 3 * * *', () => {
  checkOrdersValidity();
}, { timezone: 'Asia/Novosibirsk' });

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});