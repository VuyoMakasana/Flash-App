import { useEffect, useState, useCallback, useRef } from 'react';
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
  const [editingId, setEditingId] = useState(null);

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
      // Same handling as handleEdit below. addProduct now validates price and
      // cost_price (OPEN_FOLLOWUPS #21) and answers with the same
      // { errors: [{ path, msg }] } shape, which api.js normalizes into
      // fieldErrors — but this branch only ever showed err.message, so a
      // rejected price read as the generic "Failed to add product." and the
      // owner had no way to tell which field was wrong.
      const detail = err.fieldErrors && Object.values(err.fieldErrors).join(' ');
      setError(detail || err.message || 'Failed to add product.');
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

  async function handleImageChange(productId, file) {
    setActioningId(productId);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('image', file);
      await storeApi.updateProductImage(productId, formData);
      await loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to update image.');
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

  async function handleReactivate(productId) {
    setActioningId(productId);
    setError(null);
    try {
      await storeApi.reactivateProduct(productId);
      await loadProducts();
    } catch (err) {
      setError(err.message || 'Failed to reactivate product.');
    } finally {
      setActioningId(null);
    }
  }

  // Only the fields the owner actually changed are sent. The backend treats an
  // absent key as "leave it alone", so submitting the whole form would blank
  // every optional column the form does not render.
  async function handleEdit(productId, fields) {
    if (Object.keys(fields).length === 0) {
      setEditingId(null);
      return;
    }
    setActioningId(productId);
    setError(null);
    try {
      await storeApi.updateProduct(productId, fields);
      setEditingId(null);
      await loadProducts();
    } catch (err) {
      // A validation failure arrives as per-field messages (api.js normalizes
      // the backend's { errors: [{ path, msg }] }). Surfacing only "Failed to
      // update" would hide which field was actually rejected, and the owner
      // would have no way to tell a bad price from a bad name.
      const detail = err.fieldErrors && Object.values(err.fieldErrors).join(' ');
      setError(detail || err.message || 'Failed to update product.');
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
                  editing={editingId === product.id}
                  onStockChange={handleStockChange}
                  onImageChange={handleImageChange}
                  onDeactivate={handleDeactivate}
                  onEditToggle={() => setEditingId(editingId === product.id ? null : product.id)}
                  onEditSubmit={handleEdit}
                />
              ))
            )}
          </section>

          {inactiveProducts.length > 0 && (
            <section>
              <h2>Deactivated ({inactiveProducts.length})</h2>
              {inactiveProducts.map((product) => (
                <ProductRow
                  key={product.id}
                  product={product}
                  actioning={actioningId === product.id}
                  onReactivate={handleReactivate}
                  readOnly
                />
              ))}
            </section>
          )}
        </>
      )}
    </PortalLayout>
  );
}

function ProductRow({
  product, actioning, onStockChange, onImageChange, onDeactivate, readOnly,
  editing, onEditToggle, onEditSubmit, onReactivate,
}) {
  const stock = product.stock_by_size || {};
  const fileInputRef = useRef(null);

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (file) onImageChange(product.id, file);
    e.target.value = '';
  }

  return (
    <div className="product-row">
      {product.image_url ? (
        <img src={product.image_url} alt={product.product_name} className="product-thumb" />
      ) : (
        <div className="product-thumb product-thumb-empty">No image</div>
      )}
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
          <div className="product-row-actions">
            <input
              type="file"
              accept="image/jpeg,image/png"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={handleFileSelected}
            />
            <button className="btn-secondary" onClick={onEditToggle}>
              {editing ? 'Cancel' : 'Edit Details'}
            </button>
            <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
              {product.image_url ? 'Change Image' : 'Add Image'}
            </button>
            <button className="btn-deactivate" onClick={() => onDeactivate(product.id)}>Deactivate</button>
          </div>
        )
      )}
      {/* A deactivated product keeps its stock inputs disabled — reactivating
          is the only action that makes sense until it is back in the catalog. */}
      {readOnly && onReactivate && (
        actioning ? <span>Working…</span> : (
          <div className="product-row-actions">
            <button className="btn-secondary" onClick={() => onReactivate(product.id)}>Reactivate</button>
          </div>
        )
      )}
      {editing && !actioning && (
        <EditProductForm product={product} onSubmit={onEditSubmit} />
      )}
    </div>
  );
}

// Seeded from the product's current values so the owner edits what they see,
// and submits only what actually changed — an untouched field is left out of
// the request entirely rather than re-sent, which keeps a no-op edit from
// showing up in the audit trail as a price change.
function EditProductForm({ product, onSubmit }) {
  const [fields, setFields] = useState({
    product_name: product.product_name ?? '',
    price: String(product.price ?? ''),
    category: product.category ?? '',
    brand: product.brand ?? '',
    description: product.description ?? '',
  });

  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  function handleSubmit(e) {
    e.preventDefault();
    const changed = {};
    for (const [key, value] of Object.entries(fields)) {
      const original = key === 'price' ? String(product.price ?? '') : (product[key] ?? '');
      if (value !== original) changed[key] = value;
    }
    onSubmit(product.id, changed);
  }

  return (
    <form className="add-product-form" onSubmit={handleSubmit}>
      <label>Name<input value={fields.product_name} onChange={set('product_name')} minLength={2} maxLength={200} required /></label>
      <label>Price (R)<input type="number" min="0.01" step="0.01" max="100000" value={fields.price} onChange={set('price')} required /></label>
      <label>Category<input value={fields.category} onChange={set('category')} maxLength={100} /></label>
      <label>Brand<input value={fields.brand} onChange={set('brand')} maxLength={100} /></label>
      <label>Description<textarea value={fields.description} onChange={set('description')} maxLength={2000} /></label>
      <button type="submit">Save Changes</button>
    </form>
  );
}

function AddProductForm({ onSubmit }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [size, setSize] = useState(SIZE_OPTIONS[2]);
  const [initialStock, setInitialStock] = useState('0');
  const [imageFile, setImageFile] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    const formData = new FormData();
    formData.append('product_name', name);
    formData.append('price', price);
    if (category) formData.append('category', category);
    if (brand) formData.append('brand', brand);
    formData.append('sizes', JSON.stringify([size]));
    formData.append('stock_by_size', JSON.stringify({ [size]: Number(initialStock) || 0 }));
    if (imageFile) formData.append('image', imageFile);
    onSubmit(formData);
  }

  return (
    <form className="add-product-form" onSubmit={handleSubmit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      {/* min 0.01, not 0: the server rejects a zero price (a zero-price item
          would hand a customer free goods), and v40's CHECK (price > 0) makes
          it impossible at the database level. Matching the bound here means the
          browser catches it before a round trip, same as EditProductForm. */}
      <label>Price (R)<input type="number" min="0.01" max="100000" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>
      <label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} /></label>
      <label>Brand<input value={brand} onChange={(e) => setBrand(e.target.value)} /></label>
      <label>
        Size
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          {SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label>Initial stock<input type="number" min="0" value={initialStock} onChange={(e) => setInitialStock(e.target.value)} /></label>
      <label>
        Image (optional)
        <input type="file" accept="image/jpeg,image/png" onChange={(e) => setImageFile(e.target.files?.[0] || null)} />
      </label>
      <button type="submit">Add</button>
    </form>
  );
}
