const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    nameSnapshot: {
      type: String,
      required: true,
      trim: true
    },
    qty: {
      type: Number,
      required: true,
      min: 1
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0
    },
    returnedQty: {
      type: Number,
      min: 0,
      default: 0
    }
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    invoiceNo: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    customerName: {
      type: String,
      trim: true,
      default: 'Walk-in Customer'
    },
    items: {
      type: [saleItemSchema],
      validate: [(arr) => arr.length > 0, 'At least one item is required for a sale']
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0
    },
    status: {
      type: String,
      enum: ['completed', 'partially_returned', 'returned', 'cancelled'],
      default: 'completed'
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Sale', saleSchema);