const fs = require('fs');
const path = require('path');

const ordersFilePath = path.join(__dirname, 'orders.json');

try {
  // Читаем orders.json
  const ordersByCourier = JSON.parse(fs.readFileSync(ordersFilePath, 'utf8'));
  console.log('Текущие ключи в orders.json:', Object.keys(ordersByCourier));

  // Проверяем наличие заказов под тегом "саша"
  if (ordersByCourier['саша'] && ordersByCourier['саша'].length > 0) {
    // Переносим заказы в "sasha"
    ordersByCourier['sasha'] = [
      ...(ordersByCourier['sasha'] || []),
      ...ordersByCourier['саша']
    ];
    console.log(`Перенесено ${ordersByCourier['саша'].length} заказов из "саша" в "sasha"`);
    
    // Удаляем старый ключ
    delete ordersByCourier['саша'];
    
    // Сохраняем обновлённый orders.json
    fs.writeFileSync(ordersFilePath, JSON.stringify(ordersByCourier, null, 2));
    console.log('orders.json успешно обновлён');
  } else {
    console.log('Заказы для "саша" не найдены или уже пусты');
  }
} catch (error) {
  console.error('Ошибка при переносе заказов:', error.message);
  process.exit(1);
}