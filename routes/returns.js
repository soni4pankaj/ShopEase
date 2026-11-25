const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Return = require('../models/Return');

const router = express.Router();

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET /api/returns - List return records (supports ?saleId= and ?condition=)
router.get('/', async (req, res) => {
  try {
    const { saleId, condition } = req.query;
    const filter = {};

    if (saleId && isValidObjectId(saleId)) {
      filter.saleId = saleId;
    }

    if (condition && ['sellable', 'damaged'].includes(condition)) {
      filter['items.condition'] = condition;
    }

    const returns = await Return.find(filter)
      .populate('saleId', 'invoiceNo customerName totalAmount status')
      .sort({ createdAt: -1 });

    res.json({ success: true, returns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/returns - Process a customer return against a sale
router.post('/', async (req, res) => {
  const appliedStockChanges = [];

  try {
    const { saleId, invoiceNo, items, reason } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one returned item is required' });
    }

    // Locate the original sale by saleId or invoiceNo
    let sale = null;
    if (saleId && isValidObjectId(saleId)) {
      sale = await Sale.findById(saleId);
    } else if (invoiceNo && String(invoiceNo).trim()) {
      sale = await Sale.findOne({ invoiceNo: String(invoiceNo).trim().toUpperCase() });
    }

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Linked sale not found' });
    }

    if (sale.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot process a return for a cancelled sale' });
    }

    // Map sale items by productId
    const saleItemMap = new Map();
    for (const sItem of sale.items) {
      saleItemMap.set(String(sItem.productId), sItem);
    }

    // Validate requested return items and check against remaining returnable quantity
    const returnableByProduct = new Map();
    const normalizedReturnItems = [];
    let totalRefund = 0;

    for (const rItem of items) {
      const productId = rItem.productId ? String(rItem.productId) : '';
      const qty = Number(rItem.qty);
      const condition = rItem.condition === 'damaged' ? 'damaged' : 'sellable';

      if (!productId || !isValidObjectId(productId)) {
        return res.status(400).json({ success: false, message: 'Invalid product ID in return items' });
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Return quantity must be a whole number >= 1' });
      }
      if (!saleItemMap.has(productId)) {
        return res.status(400).json({ success: false, message: 'One or more returned products were not part of this sale' });
      }

      const saleLine = saleItemMap.get(productId);
      const remainingReturnable = saleLine.qty - (saleLine.returnedQty || 0);
      const alreadyQueuedForReturn = returnableByProduct.get(productId) || 0;

      if (alreadyQueuedForReturn + qty > remainingReturnable) {
        return res.status(400).json({
          success: false,
          message: `Cannot return ${qty} of "${saleLine.nameSnapshot}". Max returnable remaining: ${remainingReturnable - alreadyQueuedForReturn}`
        });
      }

      returnableByProduct.set(productId, alreadyQueuedForReturn + qty);

      // Default refund uses the snapshot unitPrice from the sale unless a valid non-negative refundAmount is supplied
      const refundAmount =
        rItem.refundAmount !== undefined && rItem.refundAmount !== ''
          ? Number(rItem.refundAmount)
          : saleLine.unitPrice * qty;

      if (Number.isNaN(refundAmount) || refundAmount < 0) {
        return res.status(400).json({ success: false, message: 'Refund amount must be 0 or greater' });
      }

      normalizedReturnItems.push({
        productId: saleLine.productId,
        qty,
        refundAmount,
        condition
      });

      totalRefund += refundAmount;
    }

    // Update product stock based on condition ('sellable' -> stockQty, 'damaged' -> damagedQty)
    for (const item of normalizedReturnItems) {
      const incField = item.condition === 'damaged' ? { damagedQty: item.qty } : { stockQty: item.qty };
      const updatedProduct = await Product.findByIdAndUpdate(
        item.productId,
        { $inc: incField },
        { new: true }
      );

      if (!updatedProduct) {
        throw new Error('Linked product record no longer exists');
      }

      appliedStockChanges.push({
        productId: item.productId,
        qty: item.qty,
        condition: item.condition
      });
    }

    // Update returnedQty on the Sale document
    for (const item of normalizedReturnItems) {
      const saleLine = saleItemMap.get(String(item.productId));
      saleLine.returnedQty = (saleLine.returnedQty || 0) + item.qty;
    }

    // Determine overall Sale status
    const allFullyReturned = sale.items.every((sItem) => (sItem.returnedQty || 0) >= sItem.qty);
    const anyReturned = sale.items.some((sItem) => (sItem.returnedQty || 0) > 0);

    if (allFullyReturned) {
      sale.status = 'returned';
    } else if (anyReturned) {
      sale.status = 'partially_returned';
    }

    await sale.save();

    const createdReturn = await Return.create({
      saleId: sale._id,
      items: normalizedReturnItems,
      totalRefund,
      reason: reason && String(reason).trim() ? String(reason).trim() : ''
    });

    const populatedReturn = await Return.findById(createdReturn._id).populate(
      'saleId',
      'invoiceNo customerName totalAmount status'
    );

    res.status(201).json({
      success: true,
      message: 'Customer return recorded successfully',
      returnRecord: populatedReturn,
      sale
    });
  } catch (err) {
    // Roll back stock adjustments if an error occurred mid-process
    for (const change of appliedStockChanges) {
      try {
        const revertField =
          change.condition === 'damaged' ? { damagedQty: -change.qty } : { stockQty: -change.qty };
        await Product.findByIdAndUpdate(change.productId, { $inc: revertField });
      } catch (_) {
        // Ignore rollback cleanup error
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;