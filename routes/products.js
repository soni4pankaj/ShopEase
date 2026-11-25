const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Sale = require('../models/Sale');

const router = express.Router();

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET /api/products - List active products (supports ?search= and ?category=)
router.get('/', async (req, res) => {
  try {
    const { search, category, includeInactive } = req.query;
    const filter = {};

    if (includeInactive !== 'true') {
      filter.isActive = true;
    }

    if (category && category.trim() && category !== 'All') {
      filter.category = category.trim();
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$or = [{ name: regex }, { sku: regex }, { category: regex }];
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/products/:id - Get single product details
router.get('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/products - Record a new inventory item
router.post('/', async (req, res) => {
  try {
    const { sku, name, category, costPrice, sellingPrice, stockQty, damagedQty } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Product name is required' });
    }

    const parsedCost = Number(costPrice);
    const parsedSell = Number(sellingPrice);
    const parsedStock = stockQty !== undefined && stockQty !== '' ? Number(stockQty) : 0;
    const parsedDamaged = damagedQty !== undefined && damagedQty !== '' ? Number(damagedQty) : 0;

    if (Number.isNaN(parsedCost) || parsedCost < 0) {
      return res.status(400).json({ success: false, message: 'Cost price must be 0 or greater' });
    }
    if (Number.isNaN(parsedSell) || parsedSell < 0) {
      return res.status(400).json({ success: false, message: 'Selling price must be 0 or greater' });
    }
    if (!Number.isInteger(parsedStock) || parsedStock < 0) {
      return res.status(400).json({ success: false, message: 'Stock quantity must be a whole number >= 0' });
    }
    if (!Number.isInteger(parsedDamaged) || parsedDamaged < 0) {
      return res.status(400).json({ success: false, message: 'Damaged quantity must be a whole number >= 0' });
    }

    const doc = {
      name: String(name).trim(),
      category: category && String(category).trim() ? String(category).trim() : 'General',
      costPrice: parsedCost,
      sellingPrice: parsedSell,
      stockQty: parsedStock,
      damagedQty: parsedDamaged,
      isActive: true
    };

    if (sku && String(sku).trim()) {
      doc.sku = String(sku).trim().toUpperCase();
    }

    const product = await Product.create(doc);
    res.status(201).json({ success: true, message: 'Inventory item recorded', product });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A product with this SKU already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/products/:id - Update an existing inventory item
router.put('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const { sku, name, category, costPrice, sellingPrice, stockQty, damagedQty, isActive } = req.body;
    const updates = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ success: false, message: 'Product name cannot be empty' });
      }
      updates.name = String(name).trim();
    }

    if (category !== undefined) {
      updates.category = String(category).trim() || 'General';
    }

    if (sku !== undefined) {
      updates.sku = String(sku).trim() ? String(sku).trim().toUpperCase() : undefined;
    }

    if (costPrice !== undefined) {
      const parsedCost = Number(costPrice);
      if (Number.isNaN(parsedCost) || parsedCost < 0) {
        return res.status(400).json({ success: false, message: 'Cost price must be 0 or greater' });
      }
      updates.costPrice = parsedCost;
    }

    if (sellingPrice !== undefined) {
      const parsedSell = Number(sellingPrice);
      if (Number.isNaN(parsedSell) || parsedSell < 0) {
        return res.status(400).json({ success: false, message: 'Selling price must be 0 or greater' });
      }
      updates.sellingPrice = parsedSell;
    }

    if (stockQty !== undefined) {
      const parsedStock = Number(stockQty);
      if (!Number.isInteger(parsedStock) || parsedStock < 0) {
        return res.status(400).json({ success: false, message: 'Stock quantity must be a whole number >= 0' });
      }
      updates.stockQty = parsedStock;
    }

    if (damagedQty !== undefined) {
      const parsedDamaged = Number(damagedQty);
      if (!Number.isInteger(parsedDamaged) || parsedDamaged < 0) {
        return res.status(400).json({ success: false, message: 'Damaged quantity must be a whole number >= 0' });
      }
      updates.damagedQty = parsedDamaged;
    }

    if (typeof isActive === 'boolean') {
      updates.isActive = isActive;
    }

    const unsetFields = {};
    if (sku !== undefined && !String(sku).trim()) {
      delete updates.sku;
      unsetFields.sku = '';
    }

    const updateQuery = Object.keys(unsetFields).length
      ? { $set: updates, $unset: unsetFields }
      : { $set: updates };

    const product = await Product.findByIdAndUpdate(req.params.id, updateQuery, {
      new: true,
      runValidators: true
    });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.json({ success: true, message: 'Inventory item updated', product });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A product with this SKU already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/products/:id - Delete if unused in sales, or archive (soft-delete) if sold before
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const hasSales = await Sale.exists({ 'items.productId': product._id });
    if (hasSales) {
      product.isActive = false;
      await product.save();
      return res.json({
        success: true,
        archived: true,
        message: 'Product has sales history, so it was archived instead of permanently deleted'
      });
    }

    await Product.findByIdAndDelete(product._id);
    res.json({ success: true, archived: false, message: 'Inventory item deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
