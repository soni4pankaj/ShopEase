const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'shopease-credentials.env') });

const express = require('express');
const mongoose = require('mongoose');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
const productRoutes = require('./routes/products');
const saleRoutes = require('./routes/sales');
const returnRoutes = require('./routes/returns');
const reportRoutes = require('./routes/reports');

app.use('/api/products', productRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/reports', reportRoutes);

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Connect to MongoDB & start server
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