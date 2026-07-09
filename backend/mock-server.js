const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Flash mock server running', version: '1.0' });
});

// ─── USER AUTH ───────────────────────────────
app.post('/api/auth/user/register', (req, res) => {
  const { name, email, phone } = req.body;
  res.json({
    token: 'mock_token_' + Date.now(),
    user: {
      id: 'user_' + Date.now(),
      name: name || 'New User',
      email: email || 'user@flashdelivery.co.za',
      phone: phone || '',
      terms_accepted: false,
      role: 'user'
    }
  });
});

app.post('/api/auth/user/login', (req, res) => {
  const { email } = req.body;
  res.json({
    token: 'mock_token_' + Date.now(),
    user: {
      id: 'user_123',
      name: 'Vuyo',
      email: email || 'user@flashdelivery.co.za',
      phone: '0730849837',
      terms_accepted: true,
      role: 'user'
    }
  });
});

app.post('/api/auth/user/accept-terms', (req, res) => {
  res.json({ success: true });
});

// ─── DRIVER AUTH ─────────────────────────────
app.post('/api/auth/driver/register', (req, res) => {
  const { name, email } = req.body;
  res.json({
    token: 'mock_driver_token_' + Date.now(),
    driver: {
      id: 'driver_' + Date.now(),
      name: name || 'New Driver',
      email: email || 'driver@flashdelivery.co.za',
      status: 'pending_documents',
      role: 'driver'
    }
  });
});

app.post('/api/auth/driver/login', (req, res) => {
  const { email } = req.body;
  res.json({
    token: 'mock_driver_token_' + Date.now(),
    driver: {
      id: 'driver_123',
      name: 'Test Driver',
      email: email || 'driver@flashdelivery.co.za',
      status: 'approved',
      role: 'driver',
      rating: 4.8,
      total_deliveries: 42,
      is_online: false,
      vehicle_type: 'Car'
    }
  });
});

// ─── USER PROFILE ─────────────────────────────
app.get('/api/users/me', (req, res) => {
  res.json({
    id: 'user_123',
    name: 'Vuyo',
    email: 'user@flashdelivery.co.za',
    phone: '0730849837',
    address: 'Cape Town, South Africa'
  });
});

app.put('/api/users/me', (req, res) => {
  res.json({ success: true, user: req.body });
});

// ─── ORDERS ───────────────────────────────────
app.post('/api/orders', (req, res) => {
  res.json({
    order: {
      id: 'order_' + Date.now(),
      order_number: 'FL-' + Math.floor(Math.random() * 9000 + 1000),
      status: 'payment_pending',
      total: req.body.total || 0,
      subtotal: req.body.subtotal || 0,
      delivery_fee: req.body.delivery_fee || 35,
      items: req.body.items || [],
      created_at: new Date().toISOString()
    }
  });
});

app.get('/api/orders/my-orders', (req, res) => {
  res.json({
    orders: [
      {
        id: 'order_001',
        order_number: 'FL-1001',
        status: 'delivered',
        total: 1334,
        subtotal: 1299,
        delivery_fee: 35,
        created_at: new Date().toISOString(),
        items: [
          { name: 'Velocity Windbreaker', size: 'M', quantity: 1, total_price: 1299 }
        ]
      },
      {
        id: 'order_002',
        order_number: 'FL-1002',
        status: 'en_route',
        total: 734,
        subtotal: 699,
        delivery_fee: 35,
        created_at: new Date().toISOString(),
        items: [
          { name: 'Flash Seamless Tee', size: 'S', quantity: 1, total_price: 699 }
        ]
      }
    ]
  });
});

app.get('/api/orders/:id', (req, res) => {
  res.json({
    id: req.params.id,
    order_number: 'FL-1001',
    status: 'en_route',
    total: 1334,
    items: []
  });
});

app.post('/api/orders/:id/return', (req, res) => {
  res.json({ success: true, message: 'Return request submitted' });
});

// ─── PAYMENTS ─────────────────────────────────
app.post('/api/payments/create-intent', (req, res) => {
  res.json({
    clientSecret: 'mock_client_secret_' + Date.now(),
    paymentIntentId: 'pi_mock_' + Date.now()
  });
});

app.post('/api/payments/initialize', (req, res) => {
  res.json({
    authorizationUrl: 'https://checkout.paystack.com/mock',
    reference: 'flash_mock_ref_' + Date.now(),
    accessCode: 'mock_access_code_' + Date.now(),
    amount: req.body?.amount || 0,
  });
});

app.post('/api/payments/cash-on-delivery', (req, res) => {
  res.json({ success: true, message: 'Cash on delivery confirmed' });
});

app.post('/api/payments/payflex/initiate', (req, res) => {
  res.json({ redirectUrl: 'https://payflex.co.za/mock-checkout' });
});

app.get('/api/payments/status/:orderId', (req, res) => {
  res.json({ status: 'paid', orderId: req.params.orderId });
});

// ─── TRACKING ─────────────────────────────────
app.get('/api/tracking/order/:orderId', (req, res) => {
  res.json({
    driver_name: 'Aiden Bolt',
    driver_phone: '0821234567',
    lat: -33.9249,
    lng: 18.4241,
    order_status: 'en_route'
  });
});

// ─── DRIVER ENDPOINTS ─────────────────────────
app.get('/api/drivers/me', (req, res) => {
  res.json({
    id: 'driver_123',
    name: 'Test Driver',
    email: 'driver@flashdelivery.co.za',
    status: 'approved',
    rating: 4.8,
    total_deliveries: 42,
    is_online: false,
    vehicle_type: 'Car',
    vehicle_plate: 'CA 123 456'
  });
});

app.put('/api/drivers/me', (req, res) => {
  res.json({ success: true });
});

app.post('/api/drivers/online', (req, res) => {
  res.json({ success: true, is_online: req.body.is_online });
});

app.post('/api/drivers/location', (req, res) => {
  res.json({ success: true });
});

app.get('/api/drivers/available-orders', (req, res) => {
  res.json({
    orders: [
      {
        id: 'order_available_1',
        order_number: 'FL-2001',
        pickup_address: 'V&A Waterfront, Cape Town',
        dropoff_address: 'Claremont, Cape Town',
        total: 1334,
        delivery_fee: 35,
        driver_payout: 28,
        items: [{ name: 'Velocity Windbreaker', quantity: 1 }]
      }
    ]
  });
});

app.post('/api/drivers/orders/:id/accept', (req, res) => {
  res.json({ success: true, message: 'Order accepted' });
});

app.get('/api/drivers/earnings', (req, res) => {
  res.json({
    total_earned: 3456.50,
    total_deliveries: 42,
    avg_payout: 82.30,
    deliveries: [
      { id: 'del_1', order_number: 'FL-1001', payout: 28, created_at: new Date().toISOString(), status: 'completed' },
      { id: 'del_2', order_number: 'FL-1002', payout: 35, created_at: new Date().toISOString(), status: 'completed' },
      { id: 'del_3', order_number: 'FL-1003', payout: 42, created_at: new Date().toISOString(), status: 'completed' },
    ]
  });
});

app.post('/api/drivers/documents/upload', (req, res) => {
  res.json({ success: true, url: 'https://mock-s3.amazonaws.com/doc_' + Date.now() });
});

app.put('/api/orders/:id/status', (req, res) => {
  res.json({ success: true, status: req.body.status });
});

// ─── START ────────────────────────────────────
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('⚡ Flash Mock Server running on port ' + PORT);
  console.log('📱 Apps can connect at http://10.0.0.32:' + PORT);
  console.log('');
  console.log('Routes ready:');
  console.log('  POST /api/auth/user/register');
  console.log('  POST /api/auth/user/login');
  console.log('  POST /api/auth/driver/register');
  console.log('  POST /api/auth/driver/login');
  console.log('  GET  /api/orders/my-orders');
  console.log('  GET  /api/drivers/earnings');
  console.log('  ... and more');
  console.log('');
});
// ─── v3: MESSAGES ─────────────────────────────────────────────────────────────
app.get('/api/messages/:orderId', (req, res) => {
  res.json({ messages: [] });
});
app.post('/api/messages/:orderId', (req, res) => {
  res.json({ message: { id: 'msg_' + Date.now(), sender_id: 'user_123', sender_role: 'user', content: req.body.content, created_at: new Date().toISOString() } });
});
app.get('/api/messages/:orderId/unread', (req, res) => {
  res.json({ unread: 0 });
});

// ─── v3: TRUSTED DRIVERS ──────────────────────────────────────────────────────
app.get('/api/trusted-drivers', (req, res) => {
  res.json({ trustedDrivers: [] });
});
app.get('/api/trusted-drivers/pending', (req, res) => {
  res.json({ pending: [] });
});
app.post('/api/trusted-drivers/:driverId/request', (req, res) => {
  res.json({ request: { id: 'tr_' + Date.now(), status: 'pending', driver_id: req.params.driverId } });
});
app.delete('/api/trusted-drivers/:driverId', (req, res) => {
  res.json({ success: true });
});
app.get('/api/trusted-drivers/:driverId/status', (req, res) => {
  res.json({ driver: { id: req.params.driverId, name: 'Test Driver', is_online: true, is_busy: false, rating: 4.8, trust_status: null } });
});
app.get('/api/trusted-drivers/requests', (req, res) => {
  res.json({ requests: [] });
});
app.patch('/api/trusted-drivers/:requestId/respond', (req, res) => {
  res.json({ success: true, status: req.body.action === 'accept' ? 'accepted' : 'declined' });
});

// ─── v3: NEARBY DRIVERS ───────────────────────────────────────────────────────
app.get('/api/drivers/nearby', (req, res) => {
  res.json({
    drivers: [
      { id: 'd1', name: 'Aiden Bolt', rating: 4.9, total_deliveries: 312, vehicle_type: 'E-Bike', distance_km: 1.2, estimated_fee: 35, is_online: true, is_busy: false, profile_photo_url: null },
      { id: 'd2', name: 'Leah Storm', rating: 4.8, total_deliveries: 198, vehicle_type: 'Hybrid', distance_km: 2.4, estimated_fee: 42, is_online: true, is_busy: true, profile_photo_url: null },
      { id: 'd3', name: 'Mila Dash', rating: 4.7, total_deliveries: 87, vehicle_type: 'Scooter', distance_km: 0.8, estimated_fee: 30, is_online: true, is_busy: false, profile_photo_url: null },
    ],
  });
});

// ─── v3: SIZING GUIDE ─────────────────────────────────────────────────────────
app.get('/api/sizing/guide', (req, res) => {
  res.json({
    guide: {
      chest:      { label: 'Chest',    unit: 'cm', instruction: 'Wrap the tape around the fullest part of your chest.', tip: 'Breathe normally, do not pull tight.' },
      waist:      { label: 'Waist',    unit: 'cm', instruction: 'Measure your natural waistline, 2-3cm above the belly button.', tip: 'Stand straight and do not suck in.' },
      hips:       { label: 'Hips',     unit: 'cm', instruction: 'Measure around the fullest part of your hips.', tip: 'Usually about 20cm below your waist.' },
      shoulder:   { label: 'Shoulder', unit: 'cm', instruction: 'Measure from one shoulder edge to the other.', tip: 'Easier to measure on a shirt that fits.' },
      inseam:     { label: 'Inseam',   unit: 'cm', instruction: 'Measure from crotch to the bottom of your leg.', tip: 'Measure a pair of well-fitting trousers.' },
      height:     { label: 'Height',   unit: 'cm', instruction: 'Stand barefoot against a wall and mark the top of your head.', tip: 'Measure in the morning for best accuracy.' },
      weight:     { label: 'Weight',   unit: 'kg', instruction: 'Use a bathroom scale.', tip: 'Weigh yourself in the morning.' },
      shoe_size:  { label: 'Shoe Size',  unit: 'EU', instruction: 'Trace your foot and measure heel to toe in cm. EU chart: 24cm=38, 26cm=40, 28cm=42, 30cm=44.', tip: 'Measure in the afternoon.' },
      shirt_size: { label: 'Shirt Size', unit: 'label', instruction: 'SA sizes: XS 84-88cm, S 88-92cm, M 92-96cm, L 96-100cm, XL 100-104cm.', tip: 'Go up for relaxed fit.' },
      jeans_size: { label: 'Jeans Size', unit: 'W/L', instruction: 'Waist in inches (cm ÷ 2.54). Common: 28W=71cm, 30W=76cm, 32W=81cm, 34W=86cm.', tip: 'Go one size down for stretch denim.' },
    },
  });
});
