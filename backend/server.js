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
  ordersByCourier = {}; // Если файла нет, начинаем с пустого объекта
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
  const tag = urlParams.get('tag');
  if (tag) {
    clientsByTag[tag] = clientsByTag[tag] || [];
    clientsByTag[tag].push(ws);
    console.log(`Курьер с тегом ${tag} подключился через WebSocket`);

    // Отправляем текущие заказы из файла
    const initialOrders = ordersByCourier[tag] || [];
    ws.send(JSON.stringify({ type: 'orders', data: initialOrders }));

    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
    ws.on('close', () => {
      clientsByTag[tag] = clientsByTag[tag].filter(client => client !== ws);
      console.log(`Курьер с тегом ${tag} отключился от WebSocket`);
    });
  } else {
    console.log('Тег не указан в WebSocket-запросе');
    ws.close();
  }
});

// Эндпоинт для логина
app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const courier = couriers[login];
  if (courier && courier.password === password) {
    res.json({ success: true, tag: courier.tag });
  } else {
    res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
  }
});

// Эндпоинт для получения заказов курьера (без запроса к amoCRM)
app.get('/api/leads', (req, res) => {
  const { tag } = req.query;
  const leads = ordersByCourier[tag] || [];
  res.json({ _embedded: { leads } });
});

// Эндпоинт для обновления статуса заказа
app.patch('/api/leads/:id', async (req, res) => {
  console.log('Запрос на /api/leads/:id:', req.params, req.body);
  const { id } = req.params;
  const { status_id } = req.body; // Новый status_id из фронтенда

  try {
      // Обновляем статус в amoCRM
      const response = await axios.patch(
          `https://${AMOCRM_DOMAIN}/api/v4/leads/${id}`,
          { status_id: status_id },
          { headers: { Authorization: `Bearer ${API_TOKEN}` } }
      );

      // Удаляем заказ из ordersByCourier для всех тегов
      for (const tag in ordersByCourier) {
          const initialLength = ordersByCourier[tag].length;
          ordersByCourier[tag] = ordersByCourier[tag].filter(lead => lead.id !== parseInt(id));
          if (ordersByCourier[tag].length < initialLength) {
              console.log(`Заказ ${id} удалён из ordersByCourier для тега ${tag}`);
              // Сохраняем изменения в файл
              saveOrdersToFile();
              // Отправляем обновлённый список через WebSocket
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

// Вебхук для каждого курьера (единственный триггер для запроса к amoCRM)
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
  const tag = courierData.tag;

  try {
    console.log(`Запрос к amoCRM для тега ${tag}`);
    const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      params: {
        with: 'contacts',
        filter: {
          statuses: [{ pipeline_id: 4963870, status_id: 54415026 }],
          tags: [tag]
        },
        limit: 10
      },
    });

    const newLeads = response.data._embedded.leads.filter(lead =>
      lead._embedded.tags.some(t => t.name === tag)
    );

    ordersByCourier[tag] = ordersByCourier[tag] || [];
    newLeads.forEach(newLead => {
      if (!ordersByCourier[tag].some(existing => existing.id === newLead.id)) {
        ordersByCourier[tag].push(newLead);
        console.log(`Добавлен новый заказ для ${courier}: ${newLead.id}`);
      }
    });

    saveOrdersToFile();

    // Проверка и отправка через WebSocket
    console.log(`Клиентов для тега ${tag}: ${clientsByTag[tag] ? clientsByTag[tag].length : 0}`);
    if (clientsByTag[tag] && clientsByTag[tag].length > 0) {
      clientsByTag[tag].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'orders', data: ordersByCourier[tag] }));
          console.log(`Отправлено сообщение через WebSocket для тега ${tag}`);
        } else {
          console.log(`Клиент для тега ${tag} не активен (readyState: ${client.readyState})`);
        }
      });
    } else {
      console.log(`Нет активных WebSocket-клиентов для тега ${tag}`);
    }

    res.status(200).json({ message: 'Webhook обработан' });
  } catch (error) {
    console.error(`Ошибка вебхука для ${courier}:`, error.message);
    res.status(500).json({ error: 'Ошибка обработки вебхука' });
  }
});

app.delete('/api/leads/:id', (req, res) => {
  console.log('Запрос на удаление заказа:', req.params);
  const { id } = req.params;

  // Удаляем заказ из ordersByCourier для всех тегов
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