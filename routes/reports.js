const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Return = require('../models/Return');

const router = express.Router();

function parseDateRange(startDate, endDate) {
  const range = {};

  if (startDate) {
    const start = new Date(startDate);
    if (!Number.isNaN(start.getTime())) {
      range.$gte = start;
    }
  }

  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      // If a date-only string like YYYY-MM-DD is passed, include the entire end day
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(endDate).trim())) {
        end.setHours(23, 59, 59, 999);
      }
      range.$lte = end;
    }
  }

  return Object.keys(range).length ? range : null;
}

function escapeCsvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows, columns) {
  const header = columns.map((col) => escapeCsvCell(col.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((col) => escapeCsvCell(typeof col.value === 'function' ? col.value(row) : row[col.key])).join(',')
  );
  return [header, ...lines].join('\n');
}

// GET /api/reports/summary - Overview metrics for Sales, Refunds, Net Revenue, and Stock Valuation
router.get('/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateRange = parseDateRange(startDate, endDate);

    const saleMatch = { status: { $ne: 'cancelled' } };
    if (dateRange) {
      saleMatch.createdAt = dateRange;
    }

    const returnMatch = {};
    if (dateRange) {
      returnMatch.createdAt = dateRange;
    }

    const [salesAgg, returnsAgg, products] = await Promise.all([
      Sale.aggregate([
        { $match: saleMatch },
        {
          $group: {
            _id: null,
            grossSales: { $sum: '$totalAmount' },
            orderCount: { $sum: 1 }
          }
        }
      ]),
      Return.aggregate([
        { $match: returnMatch },
        { $unwind: '$items' },
        {
          $group: {
            _id: null,
            totalRefund: { $sum: '$items.refundAmount' },
            returnedUnits: { $sum: '$items.qty' },
            sellableUnits: {
              $sum: {
                $cond: [{ $eq: ['$items.condition', 'sellable'] }, '$items.qty', 0]
              }
            },
            damagedUnits: {
              $sum: {
                $cond: [{ $eq: ['$items.condition', 'damaged'] }, '$items.qty', 0]
              }
            }
          }
        }
      ]),
      Product.find({})
    ]);

    const grossSales = salesAgg[0]?.grossSales || 0;
    const orderCount = salesAgg[0]?.orderCount || 0;
    const totalRefund = returnsAgg[0]?.totalRefund || 0;
    const returnedUnits = returnsAgg[0]?.returnedUnits || 0;
    const sellableReturnedUnits = returnsAgg[0]?.sellableUnits || 0;
    const damagedReturnedUnits = returnsAgg[0]?.damagedUnits || 0;
    const netRevenue = grossSales - totalRefund;

    let stockCostValue = 0;
    let stockRetailValue = 0;
    let totalSellableUnits = 0;
    let totalDamagedUnits = 0;
    let lowStockCount = 0;

    for (const p of products) {
      if (p.isActive) {
        stockCostValue += (p.stockQty || 0) * (p.costPrice || 0);
        stockRetailValue += (p.stockQty || 0) * (p.sellingPrice || 0);
        totalSellableUnits += p.stockQty || 0;
        if ((p.stockQty || 0) <= 5) {
          lowStockCount += 1;
        }
      }
      totalDamagedUnits += p.damagedQty || 0;
    }

    res.json({
      success: true,
      summary: {
        orderCount,
        grossSales,
        totalRefund,
        netRevenue,
        returnedUnits,
        sellableReturnedUnits,
        damagedReturnedUnits,
        activeProductCount: products.filter((p) => p.isActive).length,
        totalSellableUnits,
        totalDamagedUnits,
        lowStockCount,
        stockCostValue,
        stockRetailValue
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/reports/sales - Customizable sales report (?startDate=&endDate=&status=&groupBy=invoice|day|customer&format=csv)
router.get('/sales', async (req, res) => {
  try {
    const { startDate, endDate, status, groupBy = 'invoice', format } = req.query;
    const dateRange = parseDateRange(startDate, endDate);

    const match = {};
    if (status && status !== 'All') {
      match.status = status;
    } else {
      match.status = { $ne: 'cancelled' };
    }
    if (dateRange) {
      match.createdAt = dateRange;
    }

    let rows = [];
    let columns = [];

    if (groupBy === 'day') {
      rows = await Sale.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            orderCount: { $sum: 1 },
            unitsSold: { $sum: { $sum: '$items.qty' } },
            grossAmount: { $sum: '$totalAmount' }
          }
        },
        { $sort: { _id: -1 } },
        {
          $project: {
            _id: 0,
            date: '$_id',
            orderCount: 1,
            unitsSold: 1,
            grossAmount: 1
          }
        }
      ]);

      columns = [
        { label: 'Date', key: 'date' },
        { label: 'Orders', key: 'orderCount' },
        { label: 'Units Sold', key: 'unitsSold' },
        { label: 'Gross Sales', key: 'grossAmount' }
      ];
    } else if (groupBy === 'customer') {
      rows = await Sale.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$customerName',
            orderCount: { $sum: 1 },
            unitsSold: { $sum: { $sum: '$items.qty' } },
            grossAmount: { $sum: '$totalAmount' }
          }
        },
        { $sort: { grossAmount: -1 } },
        {
          $project: {
            _id: 0,
            customerName: '$_id',
            orderCount: 1,
            unitsSold: 1,
            grossAmount: 1
          }
        }
      ]);

      columns = [
        { label: 'Customer', key: 'customerName' },
        { label: 'Orders', key: 'orderCount' },
        { label: 'Units Sold', key: 'unitsSold' },
        { label: 'Gross Sales', key: 'grossAmount' }
      ];
    } else {
      const sales = await Sale.find(match).sort({ createdAt: -1 });
      rows = sales.map((s) => {
        const totalQty = s.items.reduce((sum, item) => sum + (item.qty || 0), 0);
        const totalReturnedQty = s.items.reduce((sum, item) => sum + (item.returnedQty || 0), 0);
        return {
          invoiceNo: s.invoiceNo,
          customerName: s.customerName,
          status: s.status,
          totalQty,
          totalReturnedQty,
          netQty: totalQty - totalReturnedQty,
          totalAmount: s.totalAmount,
          createdAt: s.createdAt
        };
      });

      columns = [
        { label: 'Invoice No', key: 'invoiceNo' },
        { label: 'Customer', key: 'customerName' },
        { label: 'Status', key: 'status' },
        { label: 'Sold Qty', key: 'totalQty' },
        { label: 'Returned Qty', key: 'totalReturnedQty' },
        { label: 'Net Qty', key: 'netQty' },
        { label: 'Total Amount', key: 'totalAmount' },
        { label: 'Date', value: (r) => new Date(r.createdAt).toISOString().slice(0, 10) }
      ];
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="shopease-sales-report.csv"');
      return res.send(toCsv(rows, columns));
    }

    res.json({ success: true, groupBy, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/reports/inventory - Inventory & valuation report (?category=&includeInactive=true|false&lowStockOnly=true|false&format=csv)
router.get('/inventory', async (req, res) => {
  try {
    const { category, includeInactive, lowStockOnly, format } = req.query;
    const filter = {};

    if (includeInactive !== 'true') {
      filter.isActive = true;
    }
    if (category && category !== 'All' && category.trim()) {
      filter.category = category.trim();
    }

    let products = await Product.find(filter).sort({ name: 1 });

    if (lowStockOnly === 'true') {
      products = products.filter((p) => (p.stockQty || 0) <= 5);
    }

    const rows = products.map((p) => {
      const stockQty = p.stockQty || 0;
      const damagedQty = p.damagedQty || 0;
      const costPrice = p.costPrice || 0;
      const sellingPrice = p.sellingPrice || 0;

      return {
        _id: p._id,
        sku: p.sku || '',
        name: p.name,
        category: p.category,
        stockQty,
        damagedQty,
        costPrice,
        sellingPrice,
        costValue: stockQty * costPrice,
        retailValue: stockQty * sellingPrice,
        potentialProfit: stockQty * (sellingPrice - costPrice),
        isActive: p.isActive
      };
    });

    if (format === 'csv') {
      const columns = [
        { label: 'SKU', key: 'sku' },
        { label: 'Product Name', key: 'name' },
        { label: 'Category', key: 'category' },
        { label: 'Sellable Stock', key: 'stockQty' },
        { label: 'Damaged Stock', key: 'damagedQty' },
        { label: 'Cost Price', key: 'costPrice' },
        { label: 'Selling Price', key: 'sellingPrice' },
        { label: 'Stock Cost Value', key: 'costValue' },
        { label: 'Stock Retail Value', key: 'retailValue' },
        { label: 'Active', key: 'isActive' }
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="shopease-inventory-report.csv"');
      return res.send(toCsv(rows, columns));
    }

    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/reports/returns - Customer returns & damage breakdown (?startDate=&endDate=&condition=sellable|damaged&format=csv)
router.get('/returns', async (req, res) => {
  try {
    const { startDate, endDate, condition, format } = req.query;
    const dateRange = parseDateRange(startDate, endDate);

    const match = {};
    if (dateRange) {
      match.createdAt = dateRange;
    }

    const returns = await Return.find(match)
      .populate('saleId', 'invoiceNo customerName')
      .populate('items.productId', 'name sku category')
      .sort({ createdAt: -1 });

    const rows = [];
    for (const ret of returns) {
      for (const item of ret.items) {
        if (condition && condition !== 'All' && item.condition !== condition) {
          continue;
        }
        rows.push({
          returnId: ret._id,
          invoiceNo: ret.saleId?.invoiceNo || '',
          customerName: ret.saleId?.customerName || '',
          productName: item.productId?.name || 'Unknown Item',
          sku: item.productId?.sku || '',
          category: item.productId?.category || 'General',
          qty: item.qty,
          condition: item.condition,
          refundAmount: item.refundAmount,
          reason: ret.reason || '',
          createdAt: ret.createdAt
        });
      }
    }

    if (format === 'csv') {
      const columns = [
        { label: 'Invoice No', key: 'invoiceNo' },
        { label: 'Customer', key: 'customerName' },
        { label: 'Product', key: 'productName' },
        { label: 'SKU', key: 'sku' },
        { label: 'Category', key: 'category' },
        { label: 'Returned Qty', key: 'qty' },
        { label: 'Condition', key: 'condition' },
        { label: 'Refund Amount', key: 'refundAmount' },
        { label: 'Reason', key: 'reason' },
        { label: 'Date', value: (r) => new Date(r.createdAt).toISOString().slice(0, 10) }
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="shopease-returns-report.csv"');
      return res.send(toCsv(rows, columns));
    }

    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/reports/performance - Product/category sales, returns, net qty, and gross margin (?startDate=&endDate=&category=&format=csv)
router.get('/performance', async (req, res) => {
  try {
    const { startDate, endDate, category, format } = req.query;
    const dateRange = parseDateRange(startDate, endDate);

    const products = await Product.find(
      category && category !== 'All' && category.trim() ? { category: category.trim() } : {}
    );

    const productMap = new Map();
    for (const p of products) {
      productMap.set(String(p._id), {
        productId: String(p._id),
        sku: p.sku || '',
        name: p.name,
        category: p.category || 'General',
        costPrice: p.costPrice || 0,
        soldQty: 0,
        returnedQty: 0,
        netSoldQty: 0,
        grossSales: 0,
        refundAmount: 0,
        netSales: 0,
        grossMargin: 0
      });
    }

    const saleMatch = { status: { $ne: 'cancelled' } };
    if (dateRange) {
      saleMatch.createdAt = dateRange;
    }

    const sales = await Sale.find(saleMatch);
    for (const sale of sales) {
      for (const item of sale.items) {
        const key = String(item.productId);
        if (!productMap.has(key)) {
          if (category && category !== 'All' && category.trim()) continue;
          productMap.set(key, {
            productId: key,
            sku: '',
            name: item.nameSnapshot,
            category: 'General',
            costPrice: 0,
            soldQty: 0,
            returnedQty: 0,
            netSoldQty: 0,
            grossSales: 0,
            refundAmount: 0,
            netSales: 0,
            grossMargin: 0
          });
        }

        const entry = productMap.get(key);
        const lineQty = item.qty || 0;
        const lineGross = lineQty * (item.unitPrice || 0);
        entry.soldQty += lineQty;
        entry.grossSales += lineGross;
      }
    }

    const returnMatch = {};
    if (dateRange) {
      returnMatch.createdAt = dateRange;
    }

    const returns = await Return.find(returnMatch);
    for (const ret of returns) {
      for (const item of ret.items) {
        const key = String(item.productId);
        if (!productMap.has(key)) continue;
        const entry = productMap.get(key);
        entry.returnedQty += item.qty || 0;
        entry.refundAmount += item.refundAmount || 0;
      }
    }

    const rows = Array.from(productMap.values())
      .map((entry) => {
        const netSoldQty = entry.soldQty - entry.returnedQty;
        const netSales = entry.grossSales - entry.refundAmount;
        const grossMargin = netSales - netSoldQty * entry.costPrice;
        return {
          ...entry,
          netSoldQty,
          netSales,
          grossMargin
        };
      })
      .sort((a, b) => b.netSales - a.netSales);

    if (format === 'csv') {
      const columns = [
        { label: 'SKU', key: 'sku' },
        { label: 'Product', key: 'name' },
        { label: 'Category', key: 'category' },
        { label: 'Sold Qty', key: 'soldQty' },
        { label: 'Returned Qty', key: 'returnedQty' },
        { label: 'Net Sold Qty', key: 'netSoldQty' },
        { label: 'Gross Sales', key: 'grossSales' },
        { label: 'Refunds', key: 'refundAmount' },
        { label: 'Net Sales', key: 'netSales' },
        { label: 'Est. Gross Margin', key: 'grossMargin' }
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="shopease-performance-report.csv"');
      return res.send(toCsv(rows, columns));
    }

    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;