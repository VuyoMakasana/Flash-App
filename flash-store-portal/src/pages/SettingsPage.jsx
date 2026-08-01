import { useEffect, useState, useCallback } from 'react';
import { storeApi } from '../services/api';
import { useStoreAuth } from '../context/StoreAuthContext';
import PortalLayout from '../components/PortalLayout';

const ROLE_OPTIONS = ['owner', 'store_manager', 'inventory_staff', 'sales_staff', 'finance', 'marketing'];

export default function SettingsPage() {
  const { storeUser } = useStoreAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [actioningId, setActioningId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const loadStaff = useCallback(async () => {
    setError(null);
    try {
      const { staff: rows } = await storeApi.getStaff();
      setStaff(rows);
    } catch (err) {
      // Same distinct access-denied state as Orders/Inventory — Settings is
      // Owner-only (FLASH_STORE_ADMIN_DESIGN.md §6.2), so every other role
      // sees this, not an empty staff list that could look like "no staff
      // exist yet."
      if (err.status === 403) {
        setAccessDenied(true);
        setError('Only the store Owner can manage staff.');
      } else {
        setError('Failed to load staff.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStaff(); }, [loadStaff]);

  async function handleAddStaff(formData) {
    setError(null);
    try {
      await storeApi.createStaff(formData);
      setShowAddForm(false);
      await loadStaff();
    } catch (err) {
      setError(err.message || 'Failed to add staff.');
    }
  }

  async function handleDeactivate(staffId) {
    setActioningId(staffId);
    setError(null);
    try {
      await storeApi.deactivateStaff(staffId);
      await loadStaff();
    } catch (err) {
      setError(err.message || 'Failed to deactivate staff.');
    } finally {
      setActioningId(null);
    }
  }

  const activeStaff = staff.filter((s) => s.is_active);
  const inactiveStaff = staff.filter((s) => !s.is_active);

  return (
    <PortalLayout>
      <div className="inventory-header-row">
        <h1>Settings — Staff</h1>
        {!accessDenied && (
          <button onClick={() => setShowAddForm((v) => !v)}>{showAddForm ? 'Cancel' : 'Add Staff'}</button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}

      {showAddForm && <AddStaffForm onSubmit={handleAddStaff} />}

      {loading ? (
        <p>Loading…</p>
      ) : accessDenied ? null : (
        <>
          <section>
            <h2>Active Staff ({activeStaff.length})</h2>
            {activeStaff.map((member) => (
              <StaffRow
                key={member.id}
                member={member}
                isSelf={member.id === storeUser?.id}
                actioning={actioningId === member.id}
                onDeactivate={handleDeactivate}
              />
            ))}
          </section>

          {inactiveStaff.length > 0 && (
            <section>
              <h2>Deactivated ({inactiveStaff.length})</h2>
              {inactiveStaff.map((member) => (
                <StaffRow key={member.id} member={member} readOnly />
              ))}
            </section>
          )}
        </>
      )}
    </PortalLayout>
  );
}

function StaffRow({ member, isSelf, actioning, onDeactivate, readOnly }) {
  return (
    <div className="product-row">
      <div className="product-row-main">
        <strong>{member.name}{isSelf ? ' (you)' : ''}</strong>
        <span>{member.email}</span>
        <span>{member.role.replace('_', ' ')}</span>
      </div>
      {!readOnly && !isSelf && (
        actioning ? <span>Working…</span> : (
          <button className="btn-deactivate" onClick={() => onDeactivate(member.id)}>Deactivate</button>
        )
      )}
    </div>
  );
}

function AddStaffForm({ onSubmit }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(ROLE_OPTIONS[3]);

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({ name, email, password, role });
  }

  return (
    <form className="add-product-form" onSubmit={handleSubmit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Password<input type="password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
        </select>
      </label>
      <button type="submit">Add Staff</button>
    </form>
  );
}
