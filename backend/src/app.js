const express = require('express');
const cors = require('cors');
const config = require('./config');
const ordersRouter = require('./routes/orders');
const missionsRouter = require('./routes/missions');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'AI Personal Assistant API',
    version: '1.1.0',
    endpoints: [
      'POST /api/missions',
      'GET /api/missions/:id',
      'POST /api/missions/:id/refresh',
      'POST /api/orders',
      'GET /api/calls/:callId',
    ],
  });
});

app.use('/api', missionsRouter);
app.use('/api', ordersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
module.exports.config = config;
