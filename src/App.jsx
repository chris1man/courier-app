import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { config } from './config';
import './App.css';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [courierLogin, setCourierLogin] = useState(null);
  const [courierTags, setCourierTags] = useState(null);

  useEffect(() => {
    const storedLogin = localStorage.getItem('courierLogin');
    const storedTags = localStorage.getItem('courierTags');
    if (storedLogin && storedTags) {
      console.log('Загружены из localStorage: login=', storedLogin, 'tags=', JSON.parse(storedTags));
      setIsLoggedIn(true);
      setCourierLogin(storedLogin);
      setCourierTags(JSON.parse(storedTags));
    }
  }, []);

  if (!isLoggedIn) {
    return <LoginPage onLogin={(login, tags) => {
      console.log('Логин:', login, 'Теги:', tags);
      setIsLoggedIn(true);
      setCourierLogin(login);
      setCourierTags(tags);
      localStorage.setItem('courierLogin', login);
      localStorage.setItem('courierTags', JSON.stringify(tags));
    }} />;
  }

  return <OrdersPage 
    courierLogin={courierLogin}
    courierTags={courierTags} 
    setIsLoggedIn={setIsLoggedIn} 
    setCourierLogin={setCourierLogin}
    setCourierTags={setCourierTags} 
  />;
}

function LoginPage({ onLogin }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    try {
      const response = await axios.post(`${import.meta.env.VITE_BACKEND_URL}/login`, { login, password });
      console.log('Ответ сервера при логине:', response.data);
      if (response.data.success) {
        onLogin(response.data.login, response.data.tags);
      } else {
        setError(response.data.message);
      }
    } catch (error) {
      setError('Ошибка при входе');
      console.error('Ошибка логина:', error);
    }
  };

  return (
    <div className="login-container">
      <div className="login-form">
        <h2>Вход для курьеров</h2>
        <input
          type="text"
          placeholder="Логин"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
        />
        <input
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p>{error}</p>}
        <button onClick={handleLogin}>Войти</button>
      </div>
    </div>
  );
}

function OrdersPage({ courierLogin, courierTags, setIsLoggedIn, setCourierLogin, setCourierTags }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeMenu, setActiveMenu] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [showInfo, setShowInfo] = useState(false);
  const [isLocationShared, setIsLocationShared] = useState(false);
  const [showReturnOptions, setShowReturnOptions] = useState(false);
  const [showLocationInstructions, setShowLocationInstructions] = useState(false);
  const wsRef = useRef(null);
  const reconnectIntervalRef = useRef(null);

  const LIVE_UPDATE_INTERVAL = 2 * 60 * 1000; // 2 минуты

  const fetchOrders = async () => {
    if (orders.length > 0) {
      console.log('Пропускаем fetchOrders, так как заказы уже есть:', orders);
      setLoading(false);
      return;
    }
    try {
      console.log('Начинаем загрузку заказов через API. Параметры:', {
        url: `${import.meta.env.VITE_BACKEND_URL}/leads`,
        tags: courierTags
      });
      
      // Запрашиваем заказы для каждого тега курьера
      const allOrders = [];
      for (const tag of courierTags) {
        const response = await axios.get(`${import.meta.env.VITE_BACKEND_URL}/leads?tag=${tag}`);
        console.log(`Ответ API заказов для тега ${tag}:`, {
          status: response.status,
          statusText: response.statusText,
          data: response.data
        });
        const tagOrders = response.data._embedded.leads || [];
        allOrders.push(...tagOrders);
      }
      
      // Удаляем дубликаты заказов по id
      const uniqueOrders = Array.from(new Map(allOrders.map(order => [order.id, order])).values());
      console.log('Загружены заказы через API:', uniqueOrders);
      setOrders(uniqueOrders);
      localStorage.setItem('cachedOrders', JSON.stringify(uniqueOrders));
      setLoading(false);
    } catch (error) {
      console.error('Ошибка начальной загрузки заказов:', {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
      setLoading(false);
      setConnectionStatus('error');
    }
  };

  const connectWebSocket = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    console.log('Логин курьера:', courierLogin, 'Теги:', courierTags);
    const wsUrl = `wss://makiapp.ru/ws?login=${courierLogin}`;
    console.log(`Попытка подключения к WebSocket: ${wsUrl}`);
    setConnectionStatus('connecting');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket подключён');
      setConnectionStatus('connected');
      fetchOrders();
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
          console.log('Отправлен ping');
        }
      }, 10000);
      ws.pingInterval = pingInterval;
    };

    ws.onmessage = (event) => {
      console.log('Получено сообщение от WebSocket:', event.data);
      if (event.data === 'pong') return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'orders') {
          console.log('Обновлены заказы:', message.data);
          setOrders(message.data || []);
          localStorage.setItem('cachedOrders', JSON.stringify(message.data || []));
          setLoading(false);
        } else if (message.type === 'locations') {
          console.log('Получены locations:', message.data);
          const loc = message.data[courierLogin.toLowerCase()];
          console.log('Данные о местоположении для курьера:', {
            courierLogin,
            courierLoginLower: courierLogin.toLowerCase(),
            locationData: loc,
            rawLocations: message.data
          });
          const isActive = loc && loc.live && (Date.now() - loc.lastUpdate < LIVE_UPDATE_INTERVAL);
          console.log(`Детальная проверка местоположения для ${courierLogin}:`, {
            hasLocation: !!loc,
            isLive: loc?.live,
            lastUpdate: loc?.lastUpdate,
            timeSinceUpdate: loc?.lastUpdate ? Date.now() - loc.lastUpdate : null,
            isWithinInterval: loc?.lastUpdate ? (Date.now() - loc.lastUpdate < LIVE_UPDATE_INTERVAL) : false,
            finalIsActive: isActive
          });
          setIsLocationShared(isActive);
          if (isActive) {
            setShowLocationInstructions(false);
          }
        }
      } catch (error) {
        console.error('Ошибка парсинга сообщения WebSocket:', error);
        setConnectionStatus('error');
      }
    };

    ws.onerror = (error) => {
      console.error('Ошибка WebSocket:', error);
      setConnectionStatus('error');
    };

    ws.onclose = () => {
      console.log('WebSocket отключён');
      setConnectionStatus('disconnected');
      wsRef.current = null;
      clearInterval(ws.pingInterval);
    };
  };

  useEffect(() => {
    const cachedOrders = localStorage.getItem('cachedOrders');
    if (cachedOrders) {
      const parsedOrders = JSON.parse(cachedOrders);
      console.log('Загружены кэшированные заказы:', parsedOrders);
      setOrders(parsedOrders);
      setLoading(false);
    } else {
      fetchOrders();
    }

    connectWebSocket();

    reconnectIntervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible' && (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
        connectWebSocket();
      }
    }, 1000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          connectWebSocket();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(reconnectIntervalRef.current);
      if (wsRef.current) {
        console.log('Закрытие WebSocket');
        wsRef.current.close();
      }
    };
  }, [courierLogin, courierTags]);

  const handleDeliver = async (id) => {
    try {
      console.log(`Отправка PATCH-запроса для доставки заказа ${id}`);
      const response = await axios.patch(`${import.meta.env.VITE_BACKEND_URL}/leads/${id}`, { status_id: config.DELIVERED_STATUS_ID });
      console.log('Ответ от сервера:', response.data);
      setOrders(orders.filter(order => order.id !== id));
      localStorage.setItem('cachedOrders', JSON.stringify(orders.filter(order => order.id !== id)));
      alert(`Заказ ${id} доставлен и удалён`);
    } catch (error) {
      console.error('Ошибка при доставке заказа:', error.response?.data || error.message);
      alert(`Не удалось отметить заказ как доставленный: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleDelete = async (id) => {
    try {
      console.log(`Отправка DELETE-запроса для удаления заказа ${id}`);
      const response = await axios.delete(`${import.meta.env.VITE_BACKEND_URL}/leads/${id}`);
      console.log('Ответ от сервера:', response.data);
      setOrders(orders.filter(order => order.id !== id));
      localStorage.setItem('cachedOrders', JSON.stringify(orders.filter(order => order.id !== id)));
      alert(`Заказ ${id} удалён`);
    } catch (error) {
      console.error('Ошибка при удалении заказа:', error.response?.data || error.message);
      alert(`Не удалось удалить заказ: ${error.response?.data?.error || error.message}`);
    }
  };

  const updateOrderSort = async (newOrders) => {
    try {
      const orderIds = newOrders.map(order => order.id);
      const response = await axios.post(`${import.meta.env.VITE_BACKEND_URL}/orders/sort`, {
        tags: courierTags,
        orderIds
      });
      if (response.status === 200) {
        console.log('Порядок успешно сохранён:', response.data.message);
        setOrders(newOrders);
        localStorage.setItem('cachedOrders', JSON.stringify(newOrders));
      }
    } catch (error) {
      console.error('Ошибка при отправке порядка заказов:', error);
      alert('Не удалось сохранить порядок');
    }
  };

  const moveOrderUp = (index) => {
    if (index === 0) return;
    const newOrders = [...orders];
    [newOrders[index - 1], newOrders[index]] = [newOrders[index], newOrders[index - 1]];
    setOrders(newOrders);
    localStorage.setItem('cachedOrders', JSON.stringify(newOrders));
    updateOrderSort(newOrders);
  };

  const moveOrderDown = (index) => {
    if (index === orders.length - 1) return;
    const newOrders = [...orders];
    [newOrders[index], newOrders[index + 1]] = [newOrders[index + 1], newOrders[index]];
    setOrders(newOrders);
    localStorage.setItem('cachedOrders', JSON.stringify(newOrders));
    updateOrderSort(newOrders);
  };

  const handleLogout = () => {
    setOrders([]);
    setIsLoggedIn(false);
    setCourierLogin(null);
    setCourierTags(null);
    localStorage.removeItem('courierLogin');
    localStorage.removeItem('courierTags');
    setIsLocationShared(false);
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  const toggleMenu = (menuId) => {
    setActiveMenu(activeMenu === menuId ? null : menuId);
  };

  const toggleInfo = () => {
    setShowInfo(!showInfo);
  };

  const handleReturnToWarehouse = () => {
    setShowReturnOptions(true);
  };

  const handleShareLocation = () => {
    setShowLocationInstructions(true);
  };

  const confirmShareLocation = () => {
    setShowLocationInstructions(false);
    window.open('https://t.me/MAKICOURIERLOC_bot', '_blank');
  };

  console.log('Рендеринг OrdersPage: orders=', orders, 'isLocationShared=', isLocationShared);

  if (loading && orders.length === 0) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <div className="orders-container">
      <div className="header-container">
        <div className="header-title">
          <h2>Ваши заказы</h2>
          <span className={`connection-indicator ${connectionStatus}`}></span>
        </div>
        <div className="header-buttons">
          <button className="refresh-button" onClick={handleRefresh}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
          </button>
          <button className="menu-button" onClick={() => toggleMenu('header')}>
            ⋮
          </button>
          {activeMenu === 'header' && (
            <div className="menu-dropdown">
              <button onClick={toggleInfo}>Информация</button>
              <button onClick={handleLogout}>Выйти</button>
            </div>
          )}
        </div>
      </div>
      {isLocationShared ? (
        orders.length === 0 ? (
          <div className="no-orders">
            {showReturnOptions ? (
              <div className="return-options">
                <p>Выберите способ вернуться в цех:</p>
                <a href="https://yandex.ru/maps/?text=Томск, Красноармейская 101а ст3" target="_blank" rel="noopener noreferrer" className="map-button">Яндекс Карты</a>
                <a href="https://2gis.ru/search/Томск, Красноармейская 101а ст3" target="_blank" rel="noopener noreferrer" className="map-button">2ГИС</a>
              </div>
            ) : (
              <>
                <p>Нет доступных заказов</p>
                <button onClick={handleReturnToWarehouse}>Вернуться в цех</button>
              </>
            )}
          </div>
        ) : (
          <ul className="order-list">
            {orders.map((order, index) => (
              <OrderItem 
                key={order.id} 
                order={order} 
                index={index} 
                totalOrders={orders.length}
                onDeliver={handleDeliver} 
                onDelete={handleDelete} 
                onMoveUp={moveOrderUp}
                onMoveDown={moveOrderDown}
                activeMenu={activeMenu} 
                toggleMenu={toggleMenu} 
              />
            ))}
          </ul>
        )
      ) : (
        <div className="location-prompt">
          <p>Поделитесь местоположением, чтобы видеть заказы</p>
          <button onClick={handleShareLocation}>Поделиться местоположением</button>
        </div>
      )}
      {showInfo && (
        <div className="info-modal">
          <div className="info-content">
            <h3>Информация о приложении</h3>
            <p><strong>Версия:</strong> v.0.2</p>
            <p><strong>Автор:</strong> 221</p>
            <p><strong>Дата создания:</strong> 03.2025</p>
            <p><strong>Описание:</strong> PWA для курьеров с интеграцией amoCRM</p>
            <p><strong>Контакты:</strong> it@makiopt.ru <a href="https://t.me/hallo221" target="_blank" rel="noopener noreferrer">@hallo221</a></p>
            <button onClick={toggleInfo}>Закрыть</button>
          </div>
        </div>
      )}
      {showLocationInstructions && (
        <div className="info-modal">
          <div className="info-content">
            <h3>Инструкция</h3>
            <p>Чтобы видеть заказы, отправьте <strong>"живое" местоположение</strong> в Telegram-боте:</p>
            <ol>
              <li>Нажмите "Поделиться местоположением" в боте.</li>
              <li>Выберите "Делиться 8 часов" (или другой длительный период).</li>
              <li>Вернитесь в приложение — заказы появятся автоматически.</li>
            </ol>
            <button onClick={confirmShareLocation}>Перейти в Telegram</button>
            <button onClick={() => setShowLocationInstructions(false)} style={{ background: '#6c757d', marginLeft: '10px' }}>Отмена</button>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderItem({ order, index, totalOrders, onDeliver, onDelete, onMoveUp, onMoveDown, activeMenu, toggleMenu }) {
  const getCustomFieldValue = (fields, fieldId) => {
    const field = fields?.find(f => f.field_id === fieldId);
    return field?.values[0]?.value || '';
  };

  const formatAddress = (address) => {
    const normalizedAddress = address.toLowerCase();
    const hasTomsk = normalizedAddress.includes('томск');
    const fullAddress = hasTomsk ? address : `г. Томск, ${address}`;
    return encodeURIComponent(fullAddress);
  };

  const phone = getCustomFieldValue(order.custom_fields_values, 293293);
  const formattedPhone = phone.startsWith('7') ? `+${phone}` : phone.startsWith('8') ? `+7${phone.slice(1)}` : phone;
  const rawAddress = getCustomFieldValue(order.custom_fields_values, 293241);
  const address = formatAddress(rawAddress);
  const contactPhone = order.contact?.phone || 'Не указан';
  const formattedContactPhone = contactPhone !== 'Не указан' ? 
    (contactPhone.startsWith('7') ? `+${contactPhone}` : contactPhone.startsWith('8') ? `+7${contactPhone.slice(1)}` : contactPhone) 
    : contactPhone;

  return (
    <li className="order-item animate-appear">
      <div className="order-content">
        <div>
          <p><strong>Номер с сайта:</strong> {order.id}</p>
          <p><strong>Номер заказчика:</strong> <a href={`tel:${formattedContactPhone}`}>{formattedContactPhone}</a></p>
          <p><strong>Дата доставки:</strong> {getCustomFieldValue(order.custom_fields_values, 1037323)}</p>
          <p><strong>Время доставки:</strong> {getCustomFieldValue(order.custom_fields_values, 293299)}</p>
          <p><strong>Адрес:</strong> {rawAddress.includes('Томск') ? rawAddress : `г. Томск, ${rawAddress}`}</p>
          <div className="map-buttons">
            <a href={`https://yandex.ru/maps/?text=${address}`} target="_blank" rel="noopener noreferrer" className="map-button">Яндекс</a>
            <a href={`https://2gis.ru/search/${address}`} target="_blank" rel="noopener noreferrer" className="map-button">2GIS</a>
          </div>
          <p><strong>Номер телефона получателя:</strong> <a href={`tel:${formattedPhone}`}>{formattedPhone}</a></p>
          <p><strong>Имя получателя:</strong> {getCustomFieldValue(order.custom_fields_values, 1018520)}</p>
          <p><strong>Сумма заказа:</strong> {order.price} ₽</p>
          <p><strong>Итог оплаты:</strong> {getCustomFieldValue(order.custom_fields_values, 1047841)}</p>
          <p><strong>Комментарий к доставке:</strong> {getCustomFieldValue(order.custom_fields_values, 1035985)}</p>
          <SwipeSlider orderId={order.id} onDeliver={onDeliver} />
        </div>
        <span className="order-number">{index + 1}</span>
      </div>
      <div className="order-item-controls">
        {index > 0 && (
          <button className="move-button" onClick={() => onMoveUp(index)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
        <div className="menu-wrapper">
          <button className="menu-button" onClick={() => toggleMenu(order.id)}>
            ⋮
          </button>
          {activeMenu === order.id && (
            <div className="menu-dropdown">
              <button onClick={() => onDeliver(order.id)}>Доставлено</button>
              <button onClick={() => onDelete(order.id)}>Удалить</button>
            </div>
          )}
        </div>
        {index < totalOrders - 1 && (
          <button className="move-button" onClick={() => onMoveDown(index)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>
    </li>
  );
}

function SwipeSlider({ orderId, onDeliver }) {
  const [position, setPosition] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);
  const maxSwipe = config.MAX_SWIPE_DISTANCE;
  const sliderRef = useRef(null);
  const startX = useRef(null);

  const interpolateColor = (start, end, factor) => {
    const r = Math.round(start[0] + (end[0] - start[0]) * factor);
    const g = Math.round(start[1] + (end[1] - start[1]) * factor);
    const b = Math.round(start[2] + (end[2] - start[2]) * factor);
    return `rgb(${r}, ${g}, ${b})`;
  };

  const startColor = [51, 51, 51];
  const endColor = [40, 167, 69];
  const progress = Math.min(position / maxSwipe, 1);
  const backgroundColor = interpolateColor(startColor, endColor, progress);

  const handleTouchStart = (e) => {
    startX.current = e.touches[0].clientX;
    setPosition(0);
    setIsCompleted(false);
  };

  const handleTouchMove = (e) => {
    if (startX.current === null) return;
    const currentX = e.touches[0].clientX;
    const deltaX = currentX - startX.current;
    const newPosition = Math.max(0, Math.min(deltaX, maxSwipe));
    setPosition(newPosition);
  };

  const handleTouchEnd = () => {
    if (position >= maxSwipe) {
      setIsCompleted(true);
      onDeliver(orderId);
    } else {
      setPosition(0);
    }
    startX.current = null;
  };

  return (
    <div className="swipe-container">
      <div className="swipe-track" style={{ width: `${maxSwipe + 50}px` }}>
        <div className="swipe-background" style={{ backgroundColor }} />
        <span className="swipe-text">Доставлено</span>
        <div
          ref={sliderRef}
          className={`swipe-slider ${isCompleted ? 'completed' : ''}`}
          style={{ transform: `translateX(${position}px)` }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {isCompleted ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="24" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;