#!/bin/bash

# Переходим в директорию скрипта
cd "$(dirname "$0")"

# Запускаем скрипт обновления заказов через PM2
echo "Запуск обновления заказов..."
pm2 start update-orders.js --name "update-orders-manual" --no-autorestart

# Выводим логи
echo "Логи обновления заказов:"
pm2 logs update-orders-manual --lines 100

# Останавливаем скрипт после завершения
pm2 stop update-orders-manual
pm2 delete update-orders-manual

echo "Обновление заказов завершено." 