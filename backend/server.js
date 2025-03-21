require('dotenv').config(); // Подключаем dotenv для чтения .env
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const config = require('./config');

const app = express();
app.use(cors());
app.use(express.json());

// Переменные из .env
const AMOCRM_DOMAIN = process.env.AMOCRM_DOMAIN;
const API_TOKEN = process.env.API_TOKEN;
const PORT = process.env.PORT || 3001;

app.get('/leads', async (req, res) => {
  try {
    const response = await axios.get(`https://${AMOCRM_DOMAIN}/api/v4/leads`, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
      },
      params: req.query,
    });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

app.patch('/leads/:id', async (req, res) => {
  try {
    const response = await axios.patch(
      `https://${AMOCRM_DOMAIN}/api/v4/leads/${req.params.id}`,
      req.body,
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});