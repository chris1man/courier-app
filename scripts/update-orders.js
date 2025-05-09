#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// Загружаем переменные окружения
dotenv.config();

// Константы из server.js
const AMOCRM_DOMAIN = process.env.AMOCRM_DOMAIN;
const API_TOKEN = process.env.API_TOKEN;
const REQUEST_DELAY = 1000;
const MAX_REQUESTS_PER_MINUTE = 30;

// Загружаем данные курьеров
let couriers;
try {
  couriers = JSON.parse(fs.readFileSync(path.join(__dirname, 'couriers.json'), 'utf8'));
  console.log('Загружены данные курьеров:', couriers);
} catch (error) {
  console.error('Ошибка загрузки couriers.json:', error.message);
  process.exit(1);
}

// Загружаем данные заказов
let ordersByCourier;
try {
  ordersByCourier = JSON.parse(fs.readFileSync(path.join(__dirname, 'orders.json'), 'utf8'));
  console.log('Загружены данные заказов');
} catch (error) {
  console.error('Ошибка загрузки orders.json:', error.message);
  ordersByCourier = {};
}

// Функция для сохранения заказов в файл
const saveOrdersToFile = () => {
  try {
    fs.writeFileSync(path.join(__dirname, 'orders.json'), JSON.stringify(ordersByCourier, null, 2));
    console.log('Заказы сохранены в orders.json');
  } catch (error) {
    console.error('Ошибка сохранения заказов в файл:', error.message);
  }
};

// Функция для проверки лимита запросов
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

// Кэш для API запросов
const apiCache = {
  data: new Map(),
  lastRequest: 0,
  requestCount: 0,
  lastReset: Date.now()
};

// Функция для запроса данных из amoCRM
async function fetchFromAmoCRM(params) {
  const cacheKey = JSON.stringify(params);
  const cachedData = apiCache.data.get(cacheKey);
  
  if (cachedData && Date.now() - cachedData.timestamp < 5 * 60 * 1000) {
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

// Функция для получения всех заказов
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

// Функция для проверки актуальности заказов
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
          console.log(`Удалено ${initialLength - ordersByCourier[tag].length} устаревших заказов для тега ${tag}`);
        }
      });

      if (i < courierList.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    console.log('Проверка актуальности заказов завершена');
  } catch (error) {
    console.error('Ошибка при проверке актуальности заказов:', error.message);
  }
};

// Запускаем проверку актуальности заказов
console.log('Запуск проверки актуальности заказов...');
checkOrdersValidity().then(() => {
  console.log('Проверка актуальности заказов выполнена');
  process.exit(0);
}).catch(error => {
  console.error('Ошибка при выполнении проверки актуальности заказов:', error);
  process.exit(1);
}); 