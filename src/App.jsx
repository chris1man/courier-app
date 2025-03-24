import { useState, useEffect } from 'react';
import { useSwipeable } from 'react-swipeable';
import axios from 'axios';
import { config } from './config';
import './App.css';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [courierTag, setCourierTag] = useState(null);

  if (!isLoggedIn) {
    return <LoginPage onLogin={(tag) => { setIsLoggedIn(true); setCourierTag(tag); }} />;
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
          setLoading(false); // Убедимся, что loading сбрасывается
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
      ws.close();
    };
  }, [courierTag]);

  const handleDeliver = async (id) => {
    try {
      await axios.patch(`${import.meta.env.VITE_BACKEND_URL}/leads/${id}`, { status_id: config.DELIVERED_STATUS_ID });
      setOrders(orders.map(order =>
        order.id === id ? { ...order, delivered: true } : order
      ));
      alert(`Заказ ${id} отмечен как доставленный`);
    } catch (error) {
      console.error('Ошибка при обновлении заказа:', error);
      alert('Не удалось обновить заказ');
    }
  };

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <div className="orders-container">
      <h2>Ваши заказы</h2>
      {orders.length === 0 ? (
        <p>Нет доступных заказов</p>
      ) : (
        <ul className="order-list">
          {orders.map((order) => (
            <li key={order.id} className="order-item">
              <p><strong>{order.name}</strong></p>
              <p>{order.address || 'Адрес не указан'}</p>
              <p><a href={`tel:${order.phone || ''}`}>{order.phone || 'Телефон не указан'}</a></p>
              {order.delivered ? (
                <p className="delivered-text">Доставлено</p>
              ) : (
                <SwipeSlider orderId={order.id} onDeliver={handleDeliver} />
              )}
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