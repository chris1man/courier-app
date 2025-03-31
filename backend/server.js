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
app.use(express.static(path.join(__dirname, 'public')));

const AMOCRM_DOMAIN = process.env.AMOCRM_DOMAIN;
const API_TOKEN = process.env.API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || 'default_secret';
const PORT = process.env.PORT || 3001;

const REQUEST_DELAY = 1000;

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

// Новый эндпоинт для сортировки заказов
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

    if (clientsByTag[tag] && clientsByTag[tag].length > 0) {
      clientsByTag[tag].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'orders', data: sortedOrders }));
          console.log(`Отправлен обновлённый порядок для тега ${tag}`);
        }
      });
    }
  });

  saveOrdersToFile();
  res.status(200).json({ message: 'Порядок заказов сохранён' });
});

// Функция задержки
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Функция проверки актуальности заказов
const checkOrdersValidity = async () => {
  console.log('Начало проверки актуальности заказов');
  try {
    const courierList = Object.keys(couriers);
    for (let i = 0; i < courierList.length; i++) {
      const courier = courierList[i];
      const tags = couriers[courier].tags || [couriers[courier].tag];
      console.log(`Проверка заказов для ${courier} с тегами ${tags.join(', ')}`);
      
      const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        params: {
          filter: {
            statuses: [{ pipeline_id: 4963870, status_id: 54415026 }],
            tags: tags
          },
          limit: 50
        },
      });

      const actualLeads = response.data._embedded.leads || [];
      const actualLeadIds = new Set(actualLeads.map(lead => lead.id));

      tags.forEach(tag => {
        if (!ordersByCourier[tag]) return;
        const initialLength = ordersByCourier[tag].length;
        ordersByCourier[tag] = ordersByCourier[tag].filter(lead => actualLeadIds.has(lead.id));
        if (ordersByCourier[tag].length < initialLength) {
          console.log(`Удалены неактуальные заказы для тега ${tag}`);
          saveOrdersToFile();
          if (clientsByTag[tag] && clientsByTag[tag].length > 0) {
            clientsByTag[tag].forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                const allOrders = tags.flatMap(t => ordersByCourier[t] || []);
                const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
                client.send(JSON.stringify({ type: 'orders', data: uniqueOrders }));
                console.log(`Отправлено обновление клиентам для тега ${tag}`);
              }
            });
          }
        }
      });

      if (i < courierList.length - 1) {
        console.log(`Ожидание ${REQUEST_DELAY}мс перед следующим запросом...`);
        await delay(REQUEST_DELAY);
      }
    }
    console.log('Проверка актуальности заказов завершена');
  } catch (error) {
    console.error('Ошибка при проверке актуальности заказов:', error.message);
  }
};

// Страница cron
app.get('/cron', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cron.html'));
});

// Обработка запуска проверки через форму
app.post('/cron', (req, res) => {
  const { secret } = req.body;
  if (secret === CRON_SECRET) {
    checkOrdersValidity();
    res.redirect('/cron?status=success');
  } else {
    res.redirect('/cron?status=error');
  }
});

// Запуск проверки каждый день в 03:05 по GMT+7 (Asia/Novosibirsk)
cron.schedule('5 3 * * *', () => {
  checkOrdersValidity();
}, {
  timezone: 'Asia/Novosibirsk'
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // checkOrdersValidity(); // Убрано, теперь проверка только по расписанию или через /cron
});

app.get('/stats', (req, res) => {
  res.send('Тестовая страница статистики');
});