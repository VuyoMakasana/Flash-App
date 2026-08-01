import { useEffect, useState, useCallback } from 'react';
import { storeApi } from '../services/api';
import PortalLayout from '../components/PortalLayout';

const SIZE_OPTIONS = ['XS', 'S', 'M', 'L', 'XL'];

export default function InventoryPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [actioningId, setActioningId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const loadProducts = useCallback(async () => {
    setError(null);
    try {
      const { products: rows } = await storeApi.getProducts();
      setProducts(rows);
    } catch (err) {
      // Same distinct access-denied state as Orders — an empty list here
      // must never be shown as "no products yet" when it actually means
      // "your role can't see this store's inventory at all."
      if (err.status === 403) {
        setAccessDenied(true);
        setError("Your role doesn't have inventory access.");
      } else {
        setError('Failed to load products.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  async function handleAddProduct(formData) {
    setError(null);
    try {
      await storeApi.addProduct(formData);
      setShowAddForm(false);
      await loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to add product.');
    }
  }

  async function handleStockChange(productId, size, newCount) {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    const updatedStock = { ...(product.stock_by_size || {}), [size]: newCount };
    setActioningId(productId);
    setError(null);
    try {
      await storeApi.updateStock(productId, updatedStock);
      await loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to update stock.');
    } finally {
      setActioningId(null);
    }
  }

  async function handleDeactivate(productId) {
    setActioningId(productId);
    setError(null);
    try {
      await storeApi.deactivateProduct(productId);
      await loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to deactivate product.');
    } finally {
      setActioningId(null);
    }
  }

  const activeProducts = products.filter((p) => p.is_active);
  const inactiveProducts = products.filter((p) => !p.is_active);

  return (
    <PortalLayout>
      <div className="inventory-header-row">
        <h1>Inventory</h1>
        {!accessDenied && (
          <button onClick={() => setShowAddForm((v) => !v)}>{showAddForm ? 'Cancel' : 'Add Product'}</button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}

      {showAddForm && <AddProductForm onSubmit={handleAddProduct} />}

      {loading ? (
        <p>Loading…</p>
      ) : accessDenied ? null : (
        <>
          <section>
            <h2>Active Products ({activeProducts.length})</h2>
            {activeProducts.length === 0 ? (
              <p>No active products.</p>
            ) : (
              activeProducts.map((product) => (
                <ProductRow
                  key={product.id}
                  product={product}
                  actioning={actioningId === product.id}
                  onStockChange={handleStockChange}
                  onDeactivate={handleDeactivate}
                />
              ))
            )}
          </section>

          {inactiveProducts.length > 0 && (
            <section>
              <h2>Deactivated ({inactiveProducts.length})</h2>
              {inactiveProducts.map((product) => (
                <ProductRow key={product.id} product={product} actioning={false} readOnly />
              ))}
            </section>
          )}
        </>
      )}
    </PortalLayout>
  );
}

function ProductRow({ product, actioning, onStockChange, onDeactivate, readOnly }) {
  const stock = product.stock_by_size || {};
  return (
    <div className="product-row">
      <div className="product-row-main">
        <strong>{product.product_name}</strong>
        <span>{product.brand || product.category || ''}</span>
        <span>R{Number(product.price).toFixed(2)}</span>
      </div>
      <div className="product-row-stock">
        {Object.keys(stock).length === 0 ? (
          <span className="stock-empty">No sizes set</span>
        ) : (
          Object.entries(stock).map(([size, count]) => (
            <label key={size} className="stock-field">
              {size}
              <input
                type="number"
                min="0"
                value={count}
                disabled={readOnly || actioning}
                onChange={(e) => onStockChange(product.id, size, Number(e.target.value))}
              />
            </label>
          ))
        )}
      </div>
      {!readOnly && (
        actioning ? <span>Working…</span> : (
          <button className="btn-deactivate" onClick={() => onDeactivate(product.id)}>Deactivate</button>
        )
      )}
    </div>
  );
}

function AddProductForm({ onSubmit }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [size, setSize] = useState(SIZE_OPTIONS[2]);
  const [initialStock, setInitialStock] = useState('0');

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({
      product_name: name,
      price: Number(price),
      category: category || null,
      brand: brand || null,
      sizes: [size],
      stock_by_size: { [size]: Number(initialStock) || 0 },
    });
  }

  return (
    <form className="add-product-form" onSubmit={handleSubmit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Price (R)<input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>
      <label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} /></label>
      <label>Brand<input value={brand} onChange={(e) => setBrand(e.target.value)} /></label>
      <label>
        Size
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          {SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label>Initial stock<input type="number" min="0" value={initialStock} onChange={(e) => setInitialStock(e.target.value)} /></label>
      <button type="submit">Add</button>
    </form>
  );
}
