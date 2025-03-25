import { useState, useEffect } from 'react';
import { useSwipeable } from 'react-swipeable';
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

  return <OrdersPage courierTag={courierTag} />;
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
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button onClick={handleLogin}>Войти</button>
    </div>
  );
}

function OrdersPage({ courierTag }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [orderMenuOpen, setOrderMenuOpen] = useState(null);

  useEffect(() => {
    const fetchInitialOrders = async () => {
      try {
        const response = await axios.get(`${import.meta.env.VITE_BACKEND_URL}/leads?tag=${courierTag}`);
        setOrders(response.data._embedded.leads || []);
        setLoading(false);
      } catch (error) {
        console.error('Ошибка начальной загрузки заказов:', error);
        setLoading(false);
      }
    };
    fetchInitialOrders();

    console.log(`Попытка подключения к WebSocket: wss://makiapp.ru/ws?tag=${courierTag}`);
    const ws = new WebSocket(`wss://makiapp.ru/ws?tag=${courierTag}`);

    ws.onopen = () => {
      console.log('WebSocket подключён');
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
      setLoading(false);
    };

    ws.onclose = () => {
      console.log('WebSocket отключён');
      setLoading(false);
    };

    return () => {
      console.log('Закрытие WebSocket');
      ws.close();
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

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <div className="orders-container">
      <div className="header-container">
        <h2>Ваши заказы</h2>
        <div>
          <button className="menu-button" onClick={() => setMenuOpen(!menuOpen)}>
            ⋮
          </button>
          {menuOpen && (
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
            <li key={order.id} className="order-item">
              <div>
                <p><strong>{order.name}</strong></p>
                <p>{order.address || 'Адрес не указан'}</p>
                <p><a href={`tel:${order.phone || ''}`}>{order.phone || 'Телефон не указан'}</a></p>
                <SwipeSlider orderId={order.id} onDeliver={handleDeliver} />
              </div>
              <div className="order-item-menu">
                <button className="menu-button" onClick={() => setOrderMenuOpen(orderMenuOpen === order.id ? null : order.id)}>
                  ⋮
                </button>
                {orderMenuOpen === order.id && (
                  <div className="menu-dropdown">
                    <button onClick={() => handleDelete(order.id)}>Удалить</button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SwipeSlider({ orderId, onDeliver }) {
  const [swipeDelta, setSwipeDelta] = useState(0);
  const maxSwipe = config.MAX_SWIPE_DISTANCE;

  const handlers = useSwipeable({
    onSwipeStart: () => setSwipeDelta(0),
    onSwiping: (eventData) => {
      if (eventData.dir === 'Right') {
        const newDelta = Math.min(eventData.deltaX, maxSwipe);
        setSwipeDelta(newDelta);
      }
    },
    onSwipedRight: () => {
      if (swipeDelta >= maxSwipe) {
        onDeliver(orderId);
      }
      setSwipeDelta(0);
    },
    onSwiped: () => setSwipeDelta(0),
    trackMouse: true,
    delta: config.SWIPE_DELTA_THRESHOLD,
  });

  return (
    <div className="swipe-container">
      <div className="swipe-track" style={{ width: `${maxSwipe + 50}px` }}>
        <div
          className="swipe-background"
          style={{ backgroundColor: swipeDelta >= maxSwipe ? '#28a745' : '#000' }}
        />
        <span className="swipe-text">Потяни для подтверждения</span>
        <div className="swipe-slider" {...handlers} style={{ transform: `translateX(${swipeDelta}px)` }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default App;