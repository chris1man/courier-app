import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { config } from './config';
import './App.css';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [courierTag, setCourierTag] = useState(null);

  useEffect(() => {
    const storedTag = localStorage.getItem('courierTag');
    if (storedTag) {
      setIsLoggedIn(true);
      setCourierTag(storedTag);
    }
  }, []);

  if (!isLoggedIn) {
    return <LoginPage onLogin={(tag) => {
      setIsLoggedIn(true);
      setCourierTag(tag);
      localStorage.setItem('courierTag', tag);
    }} />;
  }

  return <OrdersPage 
    courierTag={courierTag} 
    setIsLoggedIn={setIsLoggedIn} 
    setCourierTag={setCourierTag} 
  />;
}

function LoginPage({ onLogin }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    try {
      const response = await axios.post(`${import.meta.env.VITE_BACKEND_URL}/login`, { login, password });
      if (response.data.success) {
        onLogin(response.data.tag);
      } else {
        setError(response.data.message);
      }
    } catch (error) {
      setError('Ошибка при входе');
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

function OrdersPage({ courierTag, setIsLoggedIn, setCourierTag }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeMenu, setActiveMenu] = useState(null);
  const wsRef = useRef(null);
  const reconnectIntervalRef = useRef(null);

  const fetchOrders = async () => {
    try {
      const response = await axios.get(`${import.meta.env.VITE_BACKEND_URL}/leads?tag=${courierTag}`);
      setOrders(response.data._embedded.leads || []);
      setLoading(false);
    } catch (error) {
      console.error('Ошибка начальной загрузки заказов:', error);
      setLoading(false);
    }
  };

  const connectWebSocket = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return; // Не подключаемся, если уже есть активное соединение
    }

    console.log(`Попытка подключения к WebSocket: wss://makiapp.ru/ws?tag=${courierTag}`);
    const ws = new WebSocket(`wss://makiapp.ru/ws?tag=${courierTag}`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket подключён');
      fetchOrders(); // Синхронизация заказов при подключении
    };

    ws.onmessage = (event) => {
      console.log('Получено сообщение от WebSocket:', event.data);
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'orders') {
          console.log('Обновление заказов:', message.data);
          setOrders(message.data || []);
          setLoading(false);
        }
      } catch (error) {
        console.error('Ошибка парсинга сообщения WebSocket:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('Ошибка WebSocket:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket отключён');
      wsRef.current = null;
      // Переподключение начнётся через интервал
    };
  };

  useEffect(() => {
    fetchOrders();
    connectWebSocket();

    // Периодическая проверка состояния WebSocket
    reconnectIntervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible' && (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
        connectWebSocket();
      }
    }, 2000); // Проверка каждые 2 секунды

    // Обработка видимости страницы
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
  }, [courierTag]);

  const handleDeliver = async (id) => {
    try {
      await axios.patch(`${import.meta.env.VITE_BACKEND_URL}/leads/${id}`, { status_id: config.DELIVERED_STATUS_ID });
      setOrders(orders.filter(order => order.id !== id));
      alert(`Заказ ${id} доставлен и удалён`);
    } catch (error) {
      console.error('Ошибка при доставке заказа:', error);
      alert('Не удалось отметить заказ как доставленный');
    }
  };

  const handleDelete = async (id) => {
    try {
      await axios.delete(`${import.meta.env.VITE_BACKEND_URL}/leads/${id}`);
      setOrders(orders.filter(order => order.id !== id));
      alert(`Заказ ${id} удалён`);
    } catch (error) {
      console.error('Ошибка при удалении заказа:', error);
      alert('Не удалось удалить заказ');
    }
  };

  const handleLogout = () => {
    setOrders([]);
    setIsLoggedIn(false);
    setCourierTag(null);
    localStorage.removeItem('courierTag');
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  const toggleMenu = (menuId) => {
    setActiveMenu(activeMenu === menuId ? null : menuId);
  };

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <div className="orders-container">
      <div className="header-container">
        <h2>Ваши заказы</h2>
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
              <button onClick={handleLogout}>Выйти</button>
            </div>
          )}
        </div>
      </div>
      {orders.length === 0 ? (
        <p>Нет доступных заказов</p>
      ) : (
        <ul className="order-list">
          {orders.map((order) => (
            <OrderItem 
              key={order.id} 
              order={order} 
              onDeliver={handleDeliver} 
              onDelete={handleDelete} 
              activeMenu={activeMenu} 
              toggleMenu={toggleMenu} 
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderItem({ order, onDeliver, onDelete, activeMenu, toggleMenu }) {
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
  const formattedPhone = phone.startsWith('7') ? `+${phone}` : phone.startsWith('8') ? phone : phone;
  const rawAddress = getCustomFieldValue(order.custom_fields_values, 293241);
  const address = formatAddress(rawAddress);
  const contactPhone = order.contact?.phone || 'Не указан';

  return (
    <li className="order-item">
      <div>
        <p><strong>Номер с сайта:</strong> {order.id}</p>
        <p><strong>Номер заказчика:</strong> <a href={`tel:${contactPhone}`}>{contactPhone}</a></p>
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
      <div className="order-item-menu">
        <button className="menu-button" onClick={() => toggleMenu(order.id)}>
          ⋮
        </button>
        {activeMenu === order.id && (
          <div className="menu-dropdown">
            <button onClick={() => onDelete(order.id)}>Удалить</button>
          </div>
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

  const startColor = [51, 51, 51]; // #333
  const endColor = [40, 167, 69]; // #28a745
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
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;