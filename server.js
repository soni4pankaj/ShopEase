const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, 'shopease-credentials.env') });

const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');

const app = express();

// Trust Render's reverse proxy so secure cookies work over HTTPS
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.json());

// Session middleware
app.use(
  session({
    name: 'shopease.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12 // 12 hours
    }
  })
);

function timingSafeEqualStr(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  return res.redirect('/login.html');
}

// Public auth routes
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.APP_USERNAME;
  const validPass = process.env.APP_PASSWORD;

  if (!validUser || !validPass) {
    return res.status(500).json({ success: false, message: 'Auth credentials not configured' });
  }

  const userOk = timingSafeEqualStr(username, validUser);
  const passOk = timingSafeEqualStr(password, validPass);

  if (!userOk || !passOk) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Session error' });
    }
    req.session.authenticated = true;
    req.session.user = validUser;
    return res.json({ success: true, user: validUser });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('shopease.sid');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    success: true,
    authenticated: Boolean(req.session && req.session.authenticated),
    user: req.session?.user || null
  });
});

// Serve login page publicly (before requireAuth), then lock everything else
app.get('/login.html', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Protect static assets, main page, and API routes
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

const productRoutes = require('./routes/products');
const saleRoutes = require('./routes/sales');
const returnRoutes = require('./routes/returns');
const reportRoutes = require('./routes/reports');

app.use('/api/products', productRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/reports', reportRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

const PORT = process.env.PORT || 5000;

if (!process.env.MONGODB_URI) {
  console.error('Missing MONGODB_URI in .env');
  process.exit(1);
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB for ShopEase');
    app.listen(PORT, () => {
      console.log(`ShopEase running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });