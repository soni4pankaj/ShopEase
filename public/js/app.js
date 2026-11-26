const state = {
  products: [],
  sales: [],
  returns: [],
  cart: [],
  loadedReturnSale: null
};

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

function fmt(num) {
  return Number(num || 0).toFixed(2);
}

// --- Menu / Section Switching ---
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.section;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach((sec) => sec.classList.remove('active'));

    btn.classList.add('active');
    const sec = document.getElementById(`sec-${target}`);
    if (sec) sec.classList.add('active');

    if (target === 'dashboard') loadDashboard();
    if (target === 'inventory') loadProducts();
    if (target === 'sales') {
      loadProducts();
      loadSales();
    }
    if (target === 'returns') {
      loadSales();
      loadReturns();
    }
    if (target === 'reports') {
      syncReportControls();
      runReport();
    }
  });
});

// --- 1. DASHBOARD ---
async function loadDashboard() {
  try {
    const [sumRes, salesRes, lowRes] = await Promise.all([
      fetch('/api/reports/summary'),
      fetch('/api/reports/sales?groupBy=invoice'),
      fetch('/api/reports/inventory?lowStockOnly=true')
    ]);

    const sumData = await sumRes.json();
    if (!sumRes.ok || !sumData.success) {
      throw new Error(sumData.message || 'Failed to load summary');
    }

    const m = sumData.summary || {};
    document.getElementById('kpi-gross-sales').textContent = fmt(m.grossSales);
    document.getElementById('kpi-total-refunds').textContent = fmt(m.totalRefund);
    document.getElementById('kpi-net-revenue').textContent = fmt(m.netRevenue);
    document.getElementById('kpi-stock-cost').textContent = fmt(m.stockCostValue);
    document.getElementById('kpi-units').textContent = `${m.totalSellableUnits ?? 0} / ${m.totalDamagedUnits ?? 0}`;
    document.getElementById('kpi-low-stock').textContent = m.lowStockCount ?? 0;

    if (salesRes.ok) {
      const salesData = await salesRes.json();
      const recent = (salesData.rows || []).slice(0, 8);
      document.getElementById('dash-recent-sales').innerHTML = recent.length
        ? recent.map((s) => `
            <tr>
              <td><strong>${s.invoiceNo || ''}</strong></td>
              <td>${s.customerName || 'Walk-in Customer'}</td>
              <td><span class="badge ${s.status === 'completed' ? 'ok' : s.status === 'partially_returned' ? 'warn' : 'bad'}">${s.status || 'completed'}</span></td>
              <td>${fmt(s.totalAmount)}</td>
            </tr>
          `).join('')
        : '<tr><td colspan="4">No recent sales</td></tr>';
    }

    if (lowRes.ok) {
      const lowData = await lowRes.json();
      const lowRows = lowData.rows || [];
      document.getElementById('dash-low-stock').innerHTML = lowRows.length
        ? lowRows.map((p) => `
            <tr>
              <td>${p.sku || '-'}</td>
              <td>${p.name}</td>
              <td><span class="badge bad">${p.stockQty ?? 0}</span></td>
              <td>${fmt(p.sellingPrice)}</td>
            </tr>
          `).join('')
        : '<tr><td colspan="4">No low stock items</td></tr>';
    }
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

// --- 2. INVENTORY ---
async function loadProducts() {
  try {
    const includeInactive = document.getElementById('inv-include-inactive')?.checked ? '?includeInactive=true' : '';
    const res = await fetch(`/api/products${includeInactive}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to load products');
    }

    state.products = data.products || [];
    populateCategoryFilters();
    renderInventoryTable();
    renderSaleProductSelect();
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

function populateCategoryFilters() {
  const categories = ['All', ...new Set(state.products.map((p) => p.category || 'General'))];
  ['inv-category-filter', 'report-category'].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value || 'All';
    sel.innerHTML = categories.map((c) => `<option value="${c}">${c}</option>`).join('');
    if (categories.includes(prev)) sel.value = prev;
  });
}

function renderInventoryTable() {
  const query = (document.getElementById('inv-search')?.value || '').trim().toLowerCase();
  const cat = document.getElementById('inv-category-filter')?.value || 'All';

  const filtered = state.products.filter((p) => {
    const matchesCat = cat === 'All' || (p.category || 'General') === cat;
    const matchesText = !query ||
      (p.sku || '').toLowerCase().includes(query) ||
      (p.name || '').toLowerCase().includes(query) ||
      (p.category || '').toLowerCase().includes(query);
    return matchesCat && matchesText;
  });

  const tbody = document.getElementById('inventory-tbody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9">No inventory items found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((p) => {
    const stock = Number(p.stockQty ?? 0);
    const damaged = Number(p.damagedQty ?? 0);
    const statusBadge = p.isActive === false
      ? '<span class="badge bad">Archived</span>'
      : stock === 0
        ? '<span class="badge bad">Out of Stock</span>'
        : stock <= 5
          ? '<span class="badge warn">Low Stock</span>'
          : '<span class="badge ok">In Stock</span>';

    return `
      <tr>
        <td><strong>${p.sku || '-'}</strong></td>
        <td>${p.name}</td>
        <td>${p.category || 'General'}</td>
        <td>${fmt(p.costPrice)}</td>
        <td>${fmt(p.sellingPrice)}</td>
        <td>${stock}</td>
        <td>${damaged}</td>
        <td>${statusBadge}</td>
        <td>
          <button type="button" class="small secondary" onclick="startEditProduct('${p._id}')">Edit</button>
          <button type="button" class="small danger" onclick="deleteProduct('${p._id}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

window.startEditProduct = function (id) {
  const prod = state.products.find((p) => p._id === id);
  if (!prod) return;

  document.getElementById('edit-product-id').value = prod._id;
  document.getElementById('prod-sku').value = prod.sku || '';
  document.getElementById('prod-name').value = prod.name || '';
  document.getElementById('prod-category').value = prod.category || 'General';
  document.getElementById('prod-cost').value = prod.costPrice ?? 0;
  document.getElementById('prod-price').value = prod.sellingPrice ?? 0;
  document.getElementById('prod-stock').value = prod.stockQty ?? 0;
  document.getElementById('prod-damaged').value = prod.damagedQty ?? 0;

  document.getElementById('product-form-title').textContent = 'Update Inventory Item';
  document.getElementById('save-product-btn').textContent = 'Update Item';
  document.getElementById('cancel-edit-btn').style.display = 'inline-block';
};

function resetProductForm() {
  document.getElementById('product-form').reset();
  document.getElementById('edit-product-id').value = '';
  document.getElementById('prod-category').value = 'General';
  document.getElementById('prod-stock').value = '0';
  document.getElementById('prod-damaged').value = '0';
  document.getElementById('product-form-title').textContent = 'Record New Inventory Item';
  document.getElementById('save-product-btn').textContent = 'Save Inventory Item';
  document.getElementById('cancel-edit-btn').style.display = 'none';
}

document.getElementById('cancel-edit-btn')?.addEventListener('click', resetProductForm);

document.getElementById('product-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-product-id').value;
  const payload = {
    sku: document.getElementById('prod-sku').value.trim(),
    name: document.getElementById('prod-name').value.trim(),
    category: document.getElementById('prod-category').value.trim() || 'General',
    costPrice: Number(document.getElementById('prod-cost').value),
    sellingPrice: Number(document.getElementById('prod-price').value),
    stockQty: Number(document.getElementById('prod-stock').value),
    damagedQty: Number(document.getElementById('prod-damaged').value || 0)
  };

  try {
    const url = id ? `/api/products/${id}` : '/api/products';
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to save product');
    }

    showToast(data.message || (id ? 'Inventory item updated' : 'Inventory item recorded'));
    resetProductForm();
    loadProducts();
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

window.deleteProduct = async function (id) {
  if (!confirm('Delete or archive this inventory item?')) return;
  try {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Delete failed');
    }
    showToast(data.message || 'Inventory item updated');
    loadProducts();
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

document.getElementById('inv-search')?.addEventListener('input', renderInventoryTable);
document.getElementById('inv-category-filter')?.addEventListener('change', renderInventoryTable);
document.getElementById('inv-include-inactive')?.addEventListener('change', loadProducts);

// --- 3. SELL / INVOICES ---
function renderSaleProductSelect() {
  const sel = document.getElementById('sale-product-select');
  if (!sel) return;
  const available = state.products.filter((p) => p.isActive !== false && Number(p.stockQty) > 0);
  sel.innerHTML = available.length
    ? available.map((p) => `<option value="${p._id}">${p.sku ? p.sku + ' - ' : ''}${p.name} (Stock: ${p.stockQty}, Price: ${fmt(p.sellingPrice)})</option>`).join('')
    : '<option value="">No stock available</option>';
}

document.getElementById('add-to-cart-btn')?.addEventListener('click', () => {
  const productId = document.getElementById('sale-product-select').value;
  const qty = Number(document.getElementById('sale-qty-input').value);
  const prod = state.products.find((p) => p._id === productId);

  if (!prod) return showToast('Select a valid product', 'error');
  if (!Number.isInteger(qty) || qty < 1) return showToast('Quantity must be at least 1', 'error');

  const existing = state.cart.find((c) => c.productId === productId);
  const nextQty = (existing ? existing.qty : 0) + qty;
  if (nextQty > Number(prod.stockQty)) {
    return showToast(`Only ${prod.stockQty} units in stock`, 'error');
  }

  if (existing) {
    existing.qty = nextQty;
  } else {
    state.cart.push({
      productId: prod._id,
      name: prod.name,
      unitPrice: Number(prod.sellingPrice),
      qty
    });
  }
  renderCart();
});

function renderCart() {
  const wrap = document.getElementById('sale-cart-list');
  if (!wrap) return;

  if (!state.cart.length) {
    wrap.innerHTML = '<p style="color:#64748b;font-size:13px;">No items added to bill yet.</p>';
    document.getElementById('sale-cart-total').textContent = '0.00';
    return;
  }

  let total = 0;
  wrap.innerHTML = state.cart.map((item, idx) => {
    const sub = item.unitPrice * item.qty;
    total += sub;
    return `
      <div class="cart-item">
        <div><strong>${item.name}</strong><br><small>${fmt(item.unitPrice)} each</small></div>
        <div>Qty: <strong>${item.qty}</strong></div>
        <div><strong>${fmt(sub)}</strong></div>
        <button type="button" class="small danger" onclick="removeCartItem(${idx})">Remove</button>
      </div>
    `;
  }).join('');

  document.getElementById('sale-cart-total').textContent = fmt(total);
}

window.removeCartItem = function (idx) {
  state.cart.splice(idx, 1);
  renderCart();
};

document.getElementById('checkout-sale-btn')?.addEventListener('click', async () => {
  if (!state.cart.length) return showToast('Add items to the bill first', 'error');

  const customerName = document.getElementById('sale-customer').value.trim() || 'Walk-in Customer';
  try {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName,
        items: state.cart.map((c) => ({
          productId: c.productId,
          qty: c.qty,
          unitPrice: c.unitPrice
        }))
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to complete sale');
    }

    showToast(`Invoice ${data.sale?.invoiceNo || ''} created`);
    state.cart = [];
    document.getElementById('sale-customer').value = '';
    renderCart();
    loadProducts();
    loadSales();
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadSales() {
  try {
    const q = encodeURIComponent((document.getElementById('sales-search')?.value || '').trim());
    const status = encodeURIComponent(document.getElementById('sales-status-filter')?.value || 'All');
    const res = await fetch(`/api/sales?search=${q}&status=${status}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to load sales');
    }

    state.sales = data.sales || [];
    renderSalesTable();
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

function renderSalesTable() {
  const tbody = document.getElementById('sales-tbody');
  if (!state.sales.length) {
    tbody.innerHTML = '<tr><td colspan="5">No sales found</td></tr>';
    return;
  }

  tbody.innerHTML = state.sales.map((s) => {
    const itemCount = (s.items || []).reduce((sum, i) => sum + Number(i.qty || 0), 0);
    return `
      <tr>
        <td><strong>${s.invoiceNo}</strong></td>
        <td>${s.customerName || 'Walk-in Customer'}</td>
        <td>${itemCount}</td>
        <td>${fmt(s.totalAmount)}</td>
        <td><span class="badge ${s.status === 'completed' ? 'ok' : s.status === 'partially_returned' ? 'warn' : 'bad'}">${s.status || 'completed'}</span></td>
      </tr>
    `;
  }).join('');
}

document.getElementById('sales-search')?.addEventListener('input', loadSales);
document.getElementById('sales-status-filter')?.addEventListener('change', loadSales);

// --- 4. CUSTOMER RETURNS ---
document.getElementById('load-invoice-btn')?.addEventListener('click', async () => {
  const invNo = document.getElementById('return-invoice-input').value.trim();
  if (!invNo) return showToast('Enter an invoice number', 'error');

  try {
    const res = await fetch(`/api/sales/${encodeURIComponent(invNo)}`);
    const data = await res.json();
    if (!res.ok || !data.success || !data.sale) {
      state.loadedReturnSale = null;
      document.getElementById('return-invoice-details').innerHTML = '';
      document.getElementById('submit-return-btn').style.display = 'none';
      return showToast(data.message || 'Invoice not found', 'error');
    }

    const sale = data.sale;
    state.loadedReturnSale = sale;

    document.getElementById('return-invoice-details').innerHTML = `
      <p style="font-size:13px;margin:8px 0;"><strong>Invoice:</strong> ${sale.invoiceNo} | <strong>Customer:</strong> ${sale.customerName || 'Walk-in Customer'} | <strong>Total:</strong> ${fmt(sale.totalAmount)}</p>
      <table>
        <thead>
          <tr><th>Item</th><th>Sold</th><th>Returned</th><th>Price</th><th>Return Qty</th><th>Condition</th></tr>
        </thead>
        <tbody>
          ${(sale.items || []).map((item, i) => {
            const maxRet = Math.max(0, Number(item.qty || 0) - Number(item.returnedQty || 0));
            return `
              <tr>
                <td>${item.nameSnapshot || 'Item'}</td>
                <td>${item.qty}</td>
                <td>${item.returnedQty || 0}</td>
                <td>${fmt(item.unitPrice)}</td>
                <td><input type="number" class="ret-qty-input" data-idx="${i}" min="0" max="${maxRet}" value="0" ${maxRet === 0 ? 'disabled' : ''} style="width:75px;" /></td>
                <td>
                  <select class="ret-cond-select" data-idx="${i}" ${maxRet === 0 ? 'disabled' : ''}>
                    <option value="sellable">sellable</option>
                    <option value="damaged">damaged</option>
                  </select>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    document.getElementById('submit-return-btn').style.display = 'inline-block';
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('submit-return-btn')?.addEventListener('click', async () => {
  const sale = state.loadedReturnSale;
  if (!sale) return;

  const reason = document.getElementById('return-reason').value.trim();
  const qtyInputs = [...document.querySelectorAll('.ret-qty-input')];
  const condSelects = [...document.querySelectorAll('.ret-cond-select')];

  const items = [];
  qtyInputs.forEach((inp, idx) => {
    const qty = Number(inp.value);
    if (qty > 0) {
      const line = sale.items[idx];
      items.push({
        productId: line.productId,
        qty,
        condition: condSelects[idx]?.value || 'sellable'
      });
    }
  });

  if (!items.length) {
    return showToast('Enter a return quantity greater than 0', 'error');
  }

  try {
    const res = await fetch('/api/returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saleId: sale._id, items, reason })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to record return');
    }

    showToast(data.message || 'Return recorded');
    document.getElementById('return-invoice-input').value = '';
    document.getElementById('return-reason').value = '';
    document.getElementById('return-invoice-details').innerHTML = '';
    document.getElementById('submit-return-btn').style.display = 'none';
    state.loadedReturnSale = null;

    loadReturns();
    loadSales();
    loadProducts();
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadReturns() {
  try {
    const res = await fetch('/api/returns');
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to load returns');
    }

    const flatRows = [];
    for (const ret of (data.returns || [])) {
      const invNo = ret.saleId?.invoiceNo || '-';
      for (const item of (ret.items || [])) {
        const prod = state.products.find((p) => String(p._id) === String(item.productId));
        flatRows.push({
          invoiceNo: invNo,
          productName: prod?.name || String(item.productId),
          qty: item.qty,
          condition: item.condition,
          refundAmount: item.refundAmount
        });
      }
    }

    const tbody = document.getElementById('returns-tbody');
    tbody.innerHTML = flatRows.length
      ? flatRows.map((r) => `
          <tr>
            <td><strong>${r.invoiceNo}</strong></td>
            <td>${r.productName}</td>
            <td>${r.qty}</td>
            <td><span class="badge ${r.condition === 'sellable' ? 'ok' : 'bad'}">${r.condition}</span></td>
            <td>${fmt(r.refundAmount)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="5">No returns recorded</td></tr>';
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

// --- 5. CUSTOM REPORTS ---
function syncReportControls() {
  const type = document.getElementById('report-type')?.value;
  document.getElementById('report-groupby-wrap').style.display = type === 'sales' ? 'block' : 'none';
  document.getElementById('report-condition-wrap').style.display = type === 'returns' ? 'block' : 'none';
}

document.getElementById('report-type')?.addEventListener('change', () => {
  syncReportControls();
  runReport();
});

document.getElementById('run-report-btn')?.addEventListener('click', runReport);

function buildReportUrl(format) {
  const type = document.getElementById('report-type').value;
  const startDate = document.getElementById('report-start-date').value;
  const endDate = document.getElementById('report-end-date').value;
  const category = document.getElementById('report-category').value;
  const groupBy = document.getElementById('report-groupby').value;
  const condition = document.getElementById('report-condition').value;

  const params = new URLSearchParams();
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);
  if (category && category !== 'All') params.append('category', category);
  if (type === 'sales') params.append('groupBy', groupBy);
  if (type === 'returns' && condition !== 'All') params.append('condition', condition);
  if (format) params.append('format', format);

  const endpointMap = {
    performance: '/api/reports/performance',
    sales: '/api/reports/sales',
    inventory: '/api/reports/inventory',
    returns: '/api/reports/returns'
  };

  return { type, groupBy, url: `${endpointMap[type] || '/api/reports/performance'}?${params.toString()}` };
}

async function runReport() {
  const { type, groupBy, url } = buildReportUrl();
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Report failed');
    }

    const rows = data.rows || [];
    let headers = [];
    let mapped = [];

    if (type === 'sales' && groupBy === 'day') {
      headers = ['Date', 'Orders', 'Units Sold', 'Gross Sales'];
      mapped = rows.map((r) => [r.date, r.orderCount, r.unitsSold, fmt(r.grossAmount)]);
    } else if (type === 'sales' && groupBy === 'customer') {
      headers = ['Customer', 'Orders', 'Units Sold', 'Gross Sales'];
      mapped = rows.map((r) => [r.customerName, r.orderCount, r.unitsSold, fmt(r.grossAmount)]);
    } else if (type === 'sales') {
      headers = ['Invoice No', 'Customer', 'Status', 'Sold Qty', 'Returned Qty', 'Net Qty', 'Total'];
      mapped = rows.map((r) => [r.invoiceNo, r.customerName, r.status, r.totalQty, r.totalReturnedQty, r.netQty, fmt(r.totalAmount)]);
    } else if (type === 'inventory') {
      headers = ['SKU', 'Product', 'Category', 'Stock', 'Damaged', 'Cost Value', 'Retail Value'];
      mapped = rows.map((r) => [r.sku, r.name, r.category, r.stockQty, r.damagedQty, fmt(r.costValue), fmt(r.retailValue)]);
    } else if (type === 'returns') {
      headers = ['Invoice No', 'Customer', 'Product', 'Qty', 'Condition', 'Refund', 'Reason'];
      mapped = rows.map((r) => [r.invoiceNo, r.customerName, r.productName, r.qty, r.condition, fmt(r.refundAmount), r.reason]);
    } else {
      headers = ['SKU', 'Product', 'Category', 'Sold', 'Returned', 'Net Qty', 'Gross Sales', 'Refunds', 'Net Sales', 'Est. Margin'];
      mapped = rows.map((r) => [
        r.sku, r.name, r.category, r.soldQty, r.returnedQty, r.netSoldQty,
        fmt(r.grossSales), fmt(r.refundAmount), fmt(r.netSales), fmt(r.grossMargin)
      ]);
    }

    document.getElementById('report-output-title').textContent = `Custom Report Output (${type})`;
    document.getElementById('report-thead').innerHTML = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
    document.getElementById('report-tbody').innerHTML = mapped.length
      ? mapped.map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${headers.length}">No records for selected filters</td></tr>`;
  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
  }
}

async function logoutUser() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (!res.ok) {
      throw new Error('Failed to log out');
    }
    window.location.href = '/login.html';
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Logout failed', 'error');
  }
}

document.getElementById('logout-btn')?.addEventListener('click', logoutUser);



document.getElementById('export-csv-btn')?.addEventListener('click', () => {
  const { url } = buildReportUrl('csv');
  window.location.href = url;
});

document.getElementById('print-report-btn')?.addEventListener('click', () => {
  window.print();
});

// --- Initial Boot ---
loadDashboard();
loadProducts();
