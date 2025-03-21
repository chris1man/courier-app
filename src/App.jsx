import { useState, useEffect } from 'react';
import { useSwipeable } from 'react-swipeable';
import axios from 'axios';
import './App.css';

// Замени на свои данные
const AMOCRM_DOMAIN = 'makilk.amocrm.ru'; // Твой домен amoCRM
const CLIENT_ID = 'cb929e5a-fc99-431b-b9d6-2432aef34683'; // Твой client_id
const CLIENT_SECRET = 'your_client_secret'; // Твой client_secret
const REDIRECT_URI = 'https://abcd-123-456-789.ngrok-free.app/callback'; // Замени на свой URL от ngrok

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [accessToken, setAccessToken] = useState(null);

  const refreshAccessToken = async () => {
    try {
      const refreshToken = localStorage.getItem('refresh_token');
      const response = await axios.post(`https://${AMOCRM_DOMAIN}/oauth2/access_token`, {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        redirect_uri: REDIRECT_URI,
      });
      const { access_token, refresh_token, expires_in } = response.data;
      setAccessToken(access_token);
      localStorage.setItem('access_token', access_token);
      localStorage.setItem('refresh_token', refresh_token);
      localStorage.setItem('expires_in', Date.now() + expires_in * 1000);
      return access_token;
    } catch (error) {
      console.error('Ошибка обновления токена:', error);
      alert('Сессия истекла. Пожалуйста, войдите заново.');
      setIsLoggedIn(false);
      localStorage.clear();
      return null;
    }
  };

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');

    if (code) {
      const getAccessToken = async () => {
        try {
          const response = await axios.post(`https://${AMOCRM_DOMAIN}/oauth2/access_token`, {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
          });
          const { access_token, refresh_token, expires_in } = response.data;
          setAccessToken(access_token);
          localStorage.setItem('access_token', access_token);
          localStorage.setItem('refresh_token', refresh_token);
          localStorage.setItem('expires_in', Date.now() + expires_in * 1000);
          setIsLoggedIn(true);
          window.history.replaceState({}, document.title, '/');
        } catch (error) {
          console.error('Ошибка получения токена:', error);
          alert('Ошибка авторизации через amoCRM');
        }
      };
      getAccessToken();
    } else {
      const savedToken = localStorage.getItem('access_token');
      const expiresIn = localStorage.getItem('expires_in');
      if (savedToken && expiresIn && Date.now() < parseInt(expiresIn)) {
        setAccessToken(savedToken);
        setIsLoggedIn(true);
      } else if (savedToken && expiresIn && Date.now() >= parseInt(expiresIn)) {
        refreshAccessToken();
      }
    }
  }, []);

  const handleLogin = () => {
    const authUrl = `https://${AMOCRM_DOMAIN}/oauth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&mode=popup`;
    window.location.href = authUrl;
  };

  if (isLoggedIn) {
    return <OrdersPage accessToken={accessToken} refreshAccessToken={refreshAccessToken} />;
  }

  return (
    <div className="login-container">
      <h2>Вход для курьеров</h2>
      <button onClick={handleLogin}>Войти через amoCRM</button>
    </div>
  );
}

function OrdersPage({ accessToken, refreshAccessToken }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOrders = async () => {
      try {
        setLoading(true);
        const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            with: 'contacts',
          },
        });
        const leads = response.data._embedded.leads.map(lead => {
          const contact = lead._embedded?.contacts?.[0];
          return {
            id: lead.id,
            name: contact ? contact.name : 'Неизвестный клиент',
            address: lead.custom_fields_values?.find(field => field.field_name === 'Адрес')?.values[0]?.value || 'Адрес не указан',
            phone: contact?.custom_fields_values?.find(field => field.field_name === 'Телефон')?.values[0]?.value || 'Телефон не указан',
            delivered: lead.status_id === 142, // Замени 142 на ID статуса "Доставлено"
          };
        });
        setOrders(leads);
      } catch (error) {
        if (error.response?.status === 401) {
          const newToken = await refreshAccessToken();
          if (newToken) {
            fetchOrders();
          }
        } else {
          console.error('Ошибка загрузки заказов:', error);
          alert('Не удалось загрузить заказы из amoCRM');
        }
      } finally {
        setLoading(false);
      }
    };
    if (accessToken) {
      fetchOrders();
    }
  }, [accessToken, refreshAccessToken]);

  const handleDeliver = async (id) => {
    try {
      await axios.patch(
        `https://${AMOCRM_DOMAIN}/api/v4/leads/${id}`,
        { status_id: 142 }, // Замени 142 на ID статуса "Доставлено"
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      setOrders(orders.map(order =>
        order.id === id ? { ...order, delivered: true } : order
      ));
      alert(`Заказ ${id} отмечен как доставленный`);
    } catch (error) {
      if (error.response?.status === 401) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          handleDeliver(id);
        }
      } else {
        console.error('Ошибка при обновлении заказа:', error);
        alert('Не удалось обновить заказ в amoCRM');
      }
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
              <p>{order.address}</p>
              <p><a href={`tel:${order.phone}`}>{order.phone}</a></p>
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
  const maxSwipe = 200;

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
    delta: 10,
  });

  return (
    <div className="swipe-container">
      <div
        className="swipe-track"
        style={{
          width: `${maxSwipe + 50}px`,
        }}
      >
        <div
          className="swipe-background"
          style={{
            backgroundColor: swipeDelta >= maxSwipe ? '#28a745' : '#000',
          }}
        />
        <span className="swipe-text">Потяни для подтверждения</span>
        <div
          className="swipe-slider"
          {...handlers}
          style={{ transform: `translateX(${swipeDelta}px)` }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#000"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default App;