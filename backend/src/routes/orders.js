const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { parseOrderRequest } = require('../services/openai');
const { lookupRestaurant, toE164US } = require('../services/places');
const { placeOutboundCall, getCall } = require('../services/vapi');

const router = express.Router();

/** In-memory store for v1 */
const orders = new Map();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ai-personal-assistant' });
});

router.get('/orders', (_req, res) => {
  const list = Array.from(orders.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

router.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.json(order);
});

router.get('/calls/:callId', async (req, res) => {
  try {
    const call = await getCall(req.params.callId);
    res.json(call);
  } catch (err) {
    res.status(502).json({
      error: 'Failed to fetch call status',
      detail: err.response?.data || err.message,
    });
  }
});

/**
 * Preview restaurant lookup without placing a call.
 */
router.post('/lookup', async (req, res) => {
  try {
    const { restaurantName, locationHint, manualPhone } = req.body || {};
    if (!restaurantName) {
      return res.status(400).json({ error: 'restaurantName is required' });
    }
    const restaurant = await lookupRestaurant({ restaurantName, locationHint, manualPhone });
    if (!restaurant) {
      return res.status(404).json({
        error: 'Could not find restaurant phone number. Provide manualPhone and try again.',
      });
    }
    return res.json(restaurant);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Full flow: parse order → find restaurant → place Vapi outbound call.
 */
router.post('/orders', async (req, res) => {
  try {
    const {
      restaurantName,
      orderDetails,
      userName,
      userPhone,
      locationHint,
      manualPhone,
      dryRun,
    } = req.body || {};

    if (!restaurantName || !orderDetails || !userName || !userPhone) {
      return res.status(400).json({
        error: 'restaurantName, orderDetails, userName, and userPhone are required',
      });
    }

    const parsed = await parseOrderRequest({
      restaurantName,
      orderDetails,
      userName,
      userPhone: toE164US(userPhone),
      locationHint,
    });

    const restaurant = await lookupRestaurant({
      restaurantName: parsed.restaurantName || restaurantName,
      locationHint: locationHint || parsed.locationHint,
      manualPhone,
    });

    if (!restaurant?.phone) {
      return res.status(404).json({
        error:
          'Could not find a phone number for that restaurant. Add the number manually and resubmit.',
        parsed,
      });
    }

    const id = uuidv4();
    const record = {
      id,
      status: dryRun ? 'preview' : 'calling',
      createdAt: new Date().toISOString(),
      userName,
      userPhone: toE164US(userPhone),
      restaurant,
      order: {
        ...parsed,
        pickupName: parsed.pickupName || userName,
        pickupPhone: toE164US(parsed.pickupPhone || userPhone),
      },
      call: null,
      error: null,
    };

    if (dryRun) {
      orders.set(id, record);
      return res.status(201).json(record);
    }

    try {
      const call = await placeOutboundCall({
        order: record.order,
        restaurant: record.restaurant,
      });
      record.call = {
        id: call.id,
        status: call.status,
        createdAt: call.createdAt,
      };
      record.status = call.status || 'queued';
    } catch (err) {
      record.status = 'failed';
      record.error = err.response?.data || err.message;
      orders.set(id, record);
      return res.status(502).json(record);
    }

    orders.set(id, record);
    return res.status(201).json(record);
  } catch (err) {
    console.error('[orders] failed', err);
    return res.status(500).json({ error: err.message || 'Unexpected error' });
  }
});

module.exports = router;
module.exports.orders = orders;