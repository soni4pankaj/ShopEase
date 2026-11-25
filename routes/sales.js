const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Sale = require('../models/Sale');

const router = express.Router();

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function generateInvoiceNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INV-${y}${m}${d}-${rand}`;
}

// GET /api/sales - List sales (supports ?status= and ?search= invoice/customer)
router.get('/', async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};

    if (status && status !== 'All') {
      filter.status = status;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$or = [{ invoiceNo: regex }, { customerName: regex }];
    }

    const sales = await Sale.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, sales });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/sales/:id - Get a single sale / invoice by ID or invoiceNo
router.get('/:id', async (req, res) => {
  try {
    let sale = null;

    if (isValidObjectId(req.params.id)) {
      sale = await Sale.findById(req.params.id);
    }

    if (!sale) {
      sale = await Sale.findOne({ invoiceNo: req.params.id.trim().toUpperCase() });
    }

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }

    res.json({ success: true, sale });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/sales - Process a new sale and atomically deduct stock
router.post('/', async (req, res) => {
  const deductedItems = [];

  try {
    const { customerName, items, unitPrices } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item is required to process a sale' });
    }

    // Consolidate duplicate productIds in the same cart if sent separately
    const qtyByProduct = new Map();
    const customPriceByProduct = new Map();

    for (const entry of items) {
      const productId = entry.productId;
      const qty = Number(entry.qty);

      if (!productId || !isValidObjectId(productId)) {
        return res.status(400).json({ success: false, message: 'Invalid product ID in sale items' });
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Each sold item quantity must be a whole number >= 1' });
      }

      qtyByProduct.set(productId, (qtyByProduct.get(productId) || 0) + qty);

      if (entry.unitPrice !== undefined && entry.unitPrice !== '') {
        const price = Number(entry.unitPrice);
        if (Number.isNaN(price) || price < 0) {
          return res.status(400).json({ success: false, message: 'Unit price must be 0 or greater' });
        }
        customPriceByProduct.set(productId, price);
      }
    }

    if (unitPrices && typeof unitPrices === 'object') {
      for (const [prodId, priceVal] of Object.entries(unitPrices)) {
        if (priceVal !== undefined && priceVal !== '') {
          const price = Number(priceVal);
          if (Number.isNaN(price) || price < 0) {
            return res.status(400).json({ success: false, message: 'Unit price must be 0 or greater' });
          }
          customPriceByProduct.set(prodId, price);
        }
      }
    }

    const saleItems = [];
    let totalAmount = 0;

    // Atomically decrement stock per product; roll back prior deductions if any item is short
    for (const [productId, requestedQty] of qtyByProduct.entries()) {
      const updatedProduct = await Product.findOneAndUpdate(
        {
          _id: productId,
          isActive: true,
          stockQty: { $gte: requestedQty }
        },
        {
          $inc: { stockQty: -requestedQty }
        },
        {
          new: true
        }
      );

      if (!updatedProduct) {
        for (const prev of deductedItems) {
          await Product.findByIdAndUpdate(prev.productId, { $inc: { stockQty: prev.qty } });
        }

        const existing = await Product.findById(productId);
        if (!existing || !existing.isActive) {
          return res.status(404).json({ success: false, message: 'One or more products are unavailable or inactive' });
        }
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for "${existing.name}". Available: ${existing.stockQty}, Requested: ${requestedQty}`
        });
      }

      deductedItems.push({ productId: updatedProduct._id, qty: requestedQty });

      const unitPrice = customPriceByProduct.has(productId)
        ? customPriceByProduct.get(productId)
        : updatedProduct.sellingPrice;

      saleItems.push({
        productId: updatedProduct._id,
        nameSnapshot: updatedProduct.name,
        qty: requestedQty,
        unitPrice,
        returnedQty: 0
      });

      totalAmount += unitPrice * requestedQty;
    }

    let invoiceNo = generateInvoiceNo();
    const exists = await Sale.exists({ invoiceNo });
    if (exists) {
      invoiceNo = `${invoiceNo}-${Math.floor(10 + Math.random() * 90)}`;
    }

    const sale = await Sale.create({
      invoiceNo,
      customerName: customerName && String(customerName).trim() ? String(customerName).trim() : 'Walk-in Customer',
      items: saleItems,
      totalAmount,
      status: 'completed'
    });

    res.status(201).json({ success: true, message: 'Sale processed successfully', sale });
  } catch (err) {
    for (const prev of deductedItems) {
      try {
        await Product.findByIdAndUpdate(prev.productId, { $inc: { stockQty: prev.qty } });
      } catch (_) {
        // Ignore rollback cleanup error
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;