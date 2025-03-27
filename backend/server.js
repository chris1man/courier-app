require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const AMOCRM_DOMAIN = process.env.AMOCRM_DOMAIN;
const API_TOKEN = process.env.API_TOKEN;
const PORT = process.env.PORT || 3001;

// Загрузка курьеров из файла couriers.json
const couriersFilePath = path.join(__dirname, 'couriers.json');
let couriers;
try {
  couriers = JSON.parse(fs.readFileSync(couriersFilePath, 'utf8'));
} catch (error) {
  console.error('Ошибка загрузки файла couriers.json:', error.message);
  couriers = {};
}

// Загрузка заказов из файла orders.json
const ordersFilePath = path.join(__dirname, 'orders.json');
let ordersByCourier;
try {
  ordersByCourier = JSON.parse(fs.readFileSync(ordersFilePath, 'utf8'));
} catch (error) {
  console.error('Ошибка загрузки файла orders.json:', error.message);
  ordersByCourier = {};
}

// Сохранение заказов в файл
const saveOrdersToFile = () => {
  try {
    fs.writeFileSync(ordersFilePath, JSON.stringify(ordersByCourier, null, 2));
    console.log('Заказы сохранены в orders.json');
  } catch (error) {
    console.error('Ошибка сохранения заказов в файл:', error.message);
  }
};

// Подключение WebSocket-клиентов
const clientsByTag = {};
wss.on('connection', (ws, req) => {
  console.log('Новое WebSocket-соединение:', req.url);
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const tagsParam = urlParams.get('tags');
  const tags = tagsParam ? tagsParam.split(',') : [];

  if (tags.length > 0) {
    tags.forEach(tag => {
      clientsByTag[tag] = clientsByTag[tag] || [];
      clientsByTag[tag].push(ws);
      console.log(`Курьер подключился к тегу ${tag} через WebSocket`);
    });

    // Отправляем уникальные заказы по всем тегам
    const allOrders = tags.flatMap(tag => ordersByCourier[tag] || []);
    const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
    ws.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));

    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
    ws.on('close', () => {
      tags.forEach(tag => {
        clientsByTag[tag] = clientsByTag[tag].filter(client => client !== ws);
        console.log(`Курьер отключился от тега ${tag} через WebSocket`);
      });
    });
  } else {
    console.log('Теги не указаны в WebSocket-запросе');
    ws.close();
  }
});

// Эндпоинт для логина
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

// Эндпоинт для получения заказов курьера
app.get('/api/leads', (req, res) => {
  const { tag } = req.query;
  const tags = tag ? tag.split(',') : [];
  const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
  const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
  res.json({ _embedded: { leads: uniqueOrders } });
});

// Эндпоинт для получения телефона контакта (оставляем для совместимости)
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

// Эндпоинт для обновления статуса заказа
app.patch('/api/leads/:id', async (req, res) => {
  console.log('Запрос на /api/leads/:id:', req.params, req.body);
  const { id } = req.params;
  const { status_id } = req.body;

  try {
    const response = await axios.patch(
      `https://${AMOCRM_DOMAIN}/api/v4/leads/${id}`,
      { status_id: status_id },
      { headers: { Authorization: `Bearer ${API_TOKEN}` } }
    );

    for (const tag in ordersByCourier) {
      const initialLength = ordersByCourier[tag].length;
      ordersByCourier[tag] = ordersByCourier[tag].filter(lead => lead.id !== parseInt(id));
      if (ordersByCourier[tag].length < initialLength) {
        console.log(`Заказ ${id} удалён из ordersByCourier для тега ${tag}`);
        saveOrdersToFile();
        if (clientsByTag[tag] && clientsByTag[tag].length > 0) {
          clientsByTag[tag].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
              console.log(`Отправлен обновлённый список заказов для тега ${tag}`);
            }
          });
        }
      }
    }

    res.json(response.data);
  } catch (error) {
    console.error('Ошибка PATCH-запроса:', error.message);
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

// Вебхук для каждого курьера
app.get('/api/webhook/:courier', (req, res) => {
  const { courier } = req.params;
  if (couriers[courier]) {
    res.status(200).json({ message: 'Webhook доступен' });
  } else {
    res.status(400).json({ error: 'Курьер не найден' });
  }
});

app.post('/api/webhook/:courier', async (req, res) => {
  console.log('Получен вебхук:', req.params, req.body);
  const { courier } = req.params;
  const courierData = couriers[courier];
  if (!courierData) {
    console.log('Курьер не найден:', courier);
    return res.status(400).json({ error: 'Курьер не найден' });
  }
  const tags = courierData.tags || [courierData.tag];

  try {
    console.log(`Запрос к amoCRM для тегов ${tags.join(', ')}`);
    const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      params: {
        with: 'contacts',
        filter: {
          statuses: [{ pipeline_id: 4963870, status_id: 54415026 }],
          tags: tags
        },
        limit: 10
      },
    });

    const newLeads = response.data._embedded.leads.filter(lead =>
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
          console.log(`Добавлен новый заказ для ${courier} с тегом ${tag}: ${newLead.id}`);
        } else {
          ordersByCourier[tag][existingIndex] = newLead;
          console.log(`Обновлён заказ для ${courier} с тегом ${tag}: ${newLead.id}`);
        }
      });
    });

    saveOrdersToFile();

    tags.forEach(tag => {
      console.log(`Клиентов для тега ${tag}: ${clientsByTag[tag] ? clientsByTag[tag].length : 0}`);
      if (clientsByTag[tag] && clientsByTag[tag].length > 0) {
        clientsByTag[tag].forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
            const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
            client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
            console.log(`Отправлено сообщение через WebSocket для тега ${tag}`);
          } else {
            console.log(`Клиент для тега ${tag} не активен (readyState: ${client.readyState})`);
          }
        });
      } else {
        console.log(`Нет активных WebSocket-клиентов для тега ${tag}`);
      }
    });

    res.status(200).json({ message: 'Webhook обработан' });
  } catch (error) {
    console.error(`Ошибка вебхука для ${courier}:`, error.message);
    res.status(500).json({ error: 'Ошибка обработки вебхука' });
  }
});

app.delete('/api/leads/:id', (req, res) => {
  console.log('Запрос на удаление заказа:', req.params);
  const { id } = req.params;

  for (const tag in ordersByCourier) {
    const initialLength = ordersByCourier[tag].length;
    ordersByCourier[tag] = ordersByCourier[tag].filter(lead => lead.id !== parseInt(id));
    if (ordersByCourier[tag].length < initialLength) {
      console.log(`Заказ ${id} удалён из ordersByCourier для тега ${tag}`);
      saveOrdersToFile();
      if (clientsByTag[tag] && clientsByTag[tag].length > 0) {
        clientsByTag[tag].forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
            console.log(`Отправлен обновлённый список заказов для тега ${tag}`);
          }
        });
      }
    }
  }

  res.status(200).json({ message: `Заказ ${id} удалён из списка` });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});