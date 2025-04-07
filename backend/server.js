require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const cron = require('node-cron');

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
const REQUEST_DELAY = 1000; // Задержка между запросами к API
const QUEUE_DELAY = 5000;   // Задержка между запросами в очереди (5 секунд)

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

const clientsByTag = {};
const courierLocations = {};
const webhookQueue = {}; // Очередь вебхуков по курьерам

const courierColors = {
  "danil": "red",
  "katya": "blue",
  "sasha": "green",
  "pasha": "orange",
  "timur": "purple",
  "vladimir": "darkred",
  "alex": "darkblue"
};

// Функция для получения всех заказов с пагинацией
async function fetchAllLeads(tags, pipelineId, statusId) {
  const allLeads = [];
  let page = 1;
  const limit = 10; // Лимит запроса

  while (true) {
    try {
      const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        params: {
          with: 'contacts',
          filter: { statuses: [{ pipeline_id: pipelineId, status_id: statusId }], tags: tags },
          limit: limit,
          page: page
        },
      });
      const leads = response.data._embedded.leads || [];
      allLeads.push(...leads.filter(lead => lead._embedded.tags.some(t => tags.includes(t.name))));

      if (leads.length < limit) break; // Если вернулось меньше лимита, это последняя страница
      page++;
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY)); // Задержка между запросами
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
  const tagsParam = urlParams.get('tags');
  const tags = tagsParam ? tagsParam.split(',') : [];
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
        tags: couriers[name].tags || [couriers[name].tag || name],
        color: courierColors[name] || 'gray'
      }))
    }));
  } else if (tags.length > 0) {
    tags.forEach(tag => {
      clientsByTag[tag] = clientsByTag[tag] || [];
      clientsByTag[tag].push(ws);
      console.log(`Курьер подключился к тегу ${tag} через WebSocket`);
    });

    const allOrders = tags.flatMap(tag => ordersByCourier[tag] || []);
    const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
    ws.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));

    ws.on('message', (message) => {
      const msgString = message.toString();
      if (msgString === 'ping') {
        ws.send('pong');
        return;
      }
      try {
        const data = JSON.parse(msgString);
        if (data.type === 'location') {
          const { tags: locationTags, lat, lng } = data.data;
          if (!locationTags || !Array.isArray(locationTags)) throw new Error('Неверный формат тегов в сообщении location');
          locationTags.forEach(tag => {
            if (ordersByCourier[tag]?.length > 0) {
              courierLocations[tag] = { lat, lng, lastUpdate: Date.now() };
              console.log(`Обновлены координаты для ${tag}: ${lat}, ${lng}`);
            } else {
              delete courierLocations[tag];
            }
          });
          wss.clients.forEach(client => {
            const clientParams = new URLSearchParams(client.url?.split('?')[1] || '');
            if (client.readyState === WebSocket.OPEN && clientParams.get('type') === 'map') {
              client.send(JSON.stringify({ type: 'locations', data: courierLocations }));
            }
          });
        }
      } catch (error) {
        console.error('Ошибка обработки сообщения WebSocket:', error.message);
      }
    });

    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
    ws.on('close', () => {
      tags.forEach(tag => {
        clientsByTag[tag] = clientsByTag[tag].filter(client => client !== ws);
        console.log(`Курьер отключился от тега ${tag}`);
      });
    });
  } else {
    ws.close();
  }
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const courier = couriers[login];
  if (courier && courier.password === password) {
    const tags = courier.tags || [courier.tag];
    res.json({ success: true, tags });
  } else {
    res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
  }
});

app.get('/api/leads', (req, res) => {
  const { tag } = req.query;
  const tags = tag ? tag.split(',') : [];
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
        if (clientsByTag[tag]) {
          clientsByTag[tag].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
              console.log(`Отправлен обновлённый список заказов для тега ${tag}`);
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
  const tags = courierData.tags || [courierData.tag];

  try {
    // Инициализируем очередь для курьера, если её нет
    webhookQueue[courier] = (webhookQueue[courier] || 0) + 1;
    console.log(`Получен вебхук для ${courier}, всего: ${webhookQueue[courier]}`);

    // Первый запрос на 10 заказов
    const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      params: {
        with: 'contacts',
        filter: { statuses: [{ pipeline_id: 4963870, status_id: 54415026 }], tags: tags },
        limit: 10
      },
    });

    let newLeads = response.data._embedded.leads.filter(lead =>
      lead._embedded.tags.some(t => tags.includes(t.name))
    );

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
      if (clientsByTag[tag]) {
        clientsByTag[tag].forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
            const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
            client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
          }
        });
      }
    });

    // Если вебхуков больше 5, ставим в очередь полный запрос
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
          if (clientsByTag[tag]) {
            clientsByTag[tag].forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
                const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
                client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
              }
            });
          }
        });

        webhookQueue[courier] = 0; // Сбрасываем счётчик после обработки
        console.log(`Все заказы для ${courier} обработаны из очереди`);
      }, QUEUE_DELAY);
    }

    res.status(200).json({ message: 'Webhook обработан' });
  } catch (error) {
    console.error(`Ошибка вебхука для ${courier}:`, error.message);
    res.status(500).json({ error: 'Ошибка обработки вебхука' });
  }
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
        if (clientsByTag[tag]) {
          clientsByTag[tag].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
              console.log(`Отправлен обновлённый список заказов для тега ${tag}`);
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

    if (clientsByTag[tag]) {
      clientsByTag[tag].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'orders', data: sortedOrders }));
        }
      });
    }
  });

  saveOrdersToFile();
  res.status(200).json({ message: 'Порядок заказов сохранён' });
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const checkOrdersValidity = async () => {
  console.log('Начало проверки актуальности заказов');
  try {
    const courierList = Object.keys(couriers);
    for (let i = 0; i < courierList.length; i++) {
      const courier = courierList[i];
      const tags = couriers[courier].tags || [couriers[courier].tag];
      const allLeads = await fetchAllLeads(tags, 4963870, 54415026);
      const actualLeadIds = new Set(allLeads.map(lead => lead.id));

      tags.forEach(tag => {
        if (!ordersByCourier[tag]) return;
        const initialLength = ordersByCourier[tag].length;
        ordersByCourier[tag] = ordersByCourier[tag].filter(lead => actualLeadIds.has(lead.id));
        if (ordersByCourier[tag].length < initialLength) {
          saveOrdersToFile();
          if (clientsByTag[tag]) {
            clientsByTag[tag].forEach(client => {
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