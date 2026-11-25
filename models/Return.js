const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    qty: {
      type: Number,
      required: true,
      min: 1
    },
    refundAmount: {
      type: Number,
      required: true,
      min: 0
    },
    condition: {
      type: String,
      enum: ['sellable', 'damaged'],
      default: 'sellable'
    }
  },
  { _id: false }
);

const returnSchema = new mongoose.Schema(
  {
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sale',
      required: true
    },
    items: {
      type: [returnItemSchema],
      validate: [(arr) => arr.length > 0, 'At least one returned item is required']
    },
    totalRefund: {
      type: Number,
      required: true,
      min: 0
    },
    reason: {
      type: String,
      trim: true,
      default: ''
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Return', returnSchema);