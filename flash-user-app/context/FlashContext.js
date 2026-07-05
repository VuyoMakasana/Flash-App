/**
 * flash-user-app/context/FlashContext.js
 *
 * HIGH-4 FIX: Auth tokens (FLASH_TOKEN, FLASH_REFRESH_TOKEN) are now stored
 *   in expo-secure-store (encrypted). Only non-sensitive data (user profile
 *   JSON, cart) remain in AsyncStorage.
 *
 * MEDIUM-9 NOTE: Full context split into AuthContext + CartContext is the
 *   recommended next step. For now, token/auth operations use SecureStore
 *   while keeping the existing API surface so no screens break.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import api, { saveTokens, clearTokens } from '../services/api';

const FlashContext = createContext(null);

// Non-sensitive storage keys (AsyncStorage)
const AS_KEYS = {
  user:       'FLASH_USER',
};
const cartKey = (userId) => (userId ? `FLASH_CART_${userId}` : 'FLASH_CART_ANON');

// ─── PRODUCTS — loaded from backend, hardcoded as fallback ─────────────────
const FALLBACK_PRODUCTS = [
  { id: 'p1', name: 'Velocity Windbreaker',    category: 'Men',    price: 1299, sizes: ['S','M','L','XL','XXL'], image: 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80', badge: 'New',        description: 'Ultra-light shell with reflective seams.' },
  { id: 'p2', name: 'Flash Seamless Tee',      category: 'Women',  price: 699,  sizes: ['XS','S','M','L','XL'],  image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=800&q=80', badge: 'Bestseller', description: 'Breathable knit with cooling fibers.' },
  { id: 'p3', name: 'Circuit Court Set',       category: 'Sports', price: 1149, sizes: ['XS','S','M','L','XL'],  image: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=800&q=80', badge: 'Drop',       description: 'Match-ready kit with mesh ventilation.' },
  { id: 'p4', name: 'Everyday Stretch Chino',  category: 'Casual', price: 899,  sizes: ['28','30','32','34','36','38'], image: 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80', badge: 'Fresh', description: 'Clean tapered chino with 4-way stretch.' },
  { id: 'p5', name: 'Pulse Runner',            category: 'Sports', price: 1599, sizes: ['40','41','42','43','44','45'], image: 'https://images.unsplash.com/photo-1528701800489-20be9c1ce237?auto=format&fit=crop&w=900&q=80', badge: 'Cushion', description: 'Responsive midsole with lightning outsole.' },
  { id: 'p6', name: 'Midnight Zip Hoodie',     category: 'Men',    price: 749,  sizes: ['S','M','L','XL','XXL'], image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=800&q=80', badge: 'Layer',      description: 'Soft brushed interior, minimalist trims.' },
  { id: 'p7', name: 'Airy Wrap Dress',         category: 'Women',  price: 1199, sizes: ['XS','S','M','L','XL'],  image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=800&q=80', badge: 'Light',      description: 'Flowy wrap silhouette for day-to-night.' },
  { id: 'p8', name: 'Street Ease Set',         category: 'Casual', price: 999,  sizes: ['XS','S','M','L','XL'],  image: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=800&q=80', badge: 'Co-ord',     description: 'Relaxed twinset for lounge-to-lane.' },
];

export const STATUS_STEPS = [
  'Driver Assigned',
  'On the Way to Store',
  'Picking up your Order',
  'On the Way to You',
  'Delivered Successfully',
];

export const FlashProvider = ({ children }) => {
  const [token, setToken]               = useState(null);
  const [user, setUser]                 = useState(null);
  const [cart, setCart]                 = useState([]);
  const [orders, setOrders]             = useState([]);
  const [subscription, setSubscription] = useState('payg');
  const [hydrated, setHydrated]         = useState(false);
  const [profile, setProfileState]      = useState({ name: '', address: '', phone: '', email: '' });
  const [products, setProducts]         = useState(FALLBACK_PRODUCTS);

  // ── Hydrate from storage on mount ────────────────────────────────────────
  useEffect(() => {
    const hydrate = async () => {
      try {
        // Tokens come from SecureStore (encrypted)
        const [storedToken, storedUser] = await Promise.all([
          SecureStore.getItemAsync('FLASH_TOKEN'),
          AsyncStorage.getItem(AS_KEYS.user),
        ]);

        if (storedToken) setToken(storedToken);

        if (storedUser) {
          const u = JSON.parse(storedUser);
          setUser(u);
          setProfileState({
            name: u.name || '', address: u.address || '',
            phone: u.phone || '', email: u.email || '',
          });

          // Cart is non-sensitive — stays in AsyncStorage
          const storedCart = await AsyncStorage.getItem(cartKey(u.id)).catch(() => null);
          if (storedCart) setCart(JSON.parse(storedCart));
        }
      } catch (e) {
        console.warn('Hydration failed', e);
      } finally {
        setHydrated(true);
      }
    };
    hydrate();
  }, []);

  // Load real products from backend
  useEffect(() => {
    if (!hydrated) return;
    api.products.getAll()
      .then(data => {
        if (data.products?.length) {
          const normalised = data.products.map(p => ({
            id:          p.id,
            name:        p.product_name,
            category:    p.category    || 'All',
            price:       parseFloat(p.price),
            sizes:       Array.isArray(p.sizes) ? p.sizes : JSON.parse(p.sizes || '[]'),
            image:       p.image_url   || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800',
            badge:       p.brand       || null,
            description: p.description || '',
            storeId:     p.store_id    || 'flash_closet',
          }));
          setProducts(normalised);
        }
      })
      .catch(() => {});
  }, [hydrated]);

  // Persist cart (non-sensitive — AsyncStorage is fine)
  useEffect(() => {
    if (hydrated) AsyncStorage.setItem(cartKey(user?.id), JSON.stringify(cart));
  }, [cart, hydrated, user?.id]);

  const isAuthenticated = !!token && !!user;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const _postLogin = useCallback(async (data) => {
    // Tokens → SecureStore (encrypted)
    await saveTokens(data.token, data.refreshToken);
    // User profile snapshot → AsyncStorage (non-sensitive)
    await AsyncStorage.setItem(AS_KEYS.user, JSON.stringify(data.user));

    setToken(data.token);
    setUser(data.user);
    setProfileState({
      name: data.user.name || '', address: data.user.address || '',
      phone: data.user.phone || '', email: data.user.email || '',
    });

    const storedCart = await AsyncStorage.getItem(cartKey(data.user.id)).catch(() => null);
    if (storedCart) setCart(JSON.parse(storedCart));
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.auth.login(email, password);
    await _postLogin(data);
    return data;
  }, [_postLogin]);

  const register = useCallback(async (name, email, password, phone) => {
    const data = await api.auth.register(name, email, password, phone);
    await _postLogin(data);
    return data;
  }, [_postLogin]);

  const loginWithApple = useCallback(async (identityToken, fullName, email) => {
    const data = await api.auth.appleSignIn(identityToken, fullName, email);
    await _postLogin(data);
    return data;
  }, [_postLogin]);

  const loginWithGoogle = useCallback(async (idToken) => {
    const data = await api.auth.googleSignIn(idToken);
    await _postLogin(data);
    return data;
  }, [_postLogin]);

  const acceptTermsAndAuthenticate = useCallback(async () => {
    try { await api.auth.acceptTerms(); } catch (_e) {}
    const updatedUser = { ...user, terms_accepted: true };
    setUser(updatedUser);
    await AsyncStorage.setItem(AS_KEYS.user, JSON.stringify(updatedUser));
  }, [user]);

  const logout = useCallback(async () => {
    // api.auth.logout() revokes the refresh token server-side (POST
    // /auth/logout) before clearing local tokens — previously this only
    // cleared SecureStore locally, leaving the refresh_tokens row live
    // server-side until it expired naturally or the periodic purge job ran.
    await api.auth.logout();
    // Clear non-sensitive AsyncStorage data. The cart is intentionally left
    // in place — it's already namespaced per user id (cartKey(user.id)), so
    // there's no leak risk in keeping it, and deleting it here previously
    // meant a user with items in their cart who tapped Logout (a plain "Are
    // you sure?" alert with no mention of the cart) lost it permanently,
    // with nothing waiting for them on their next login.
    await AsyncStorage.multiRemove([AS_KEYS.user]).catch(() => {});
    await AsyncStorage.removeItem('FLASH_CHECKOUT_DRAFT').catch(() => {});

    setToken(null);
    setUser(null);
    setOrders([]);
    setCart([]);
  }, []);

  const handleSessionExpired = useCallback(async () => {
    await clearTokens();
    await AsyncStorage.removeItem(AS_KEYS.user).catch(() => {});
    setToken(null);
    setUser(null);
    setOrders([]);
    setCart([]);
  }, []);

  // ── Profile ───────────────────────────────────────────────────────────────
  const updateProfile = useCallback(async (data) => {
    const payload = {
      name:    data?.name    ?? profile.name,
      phone:   data?.phone   ?? profile.phone,
      address: data?.address ?? profile.address,
      email:   data?.email   ?? profile.email,
    };
    const result   = await api.user.updateProfile(payload);
    const nextUser = result.user;
    setUser(nextUser);
    setProfileState({
      name: nextUser.name || '', phone: nextUser.phone || '',
      address: nextUser.address || '', email: nextUser.email || '',
    });
    await AsyncStorage.setItem(AS_KEYS.user, JSON.stringify(nextUser));
    return nextUser;
  }, [profile]);

  // Refresh profile on token change
  useEffect(() => {
    if (!token || !hydrated) return;
    api.user.getProfile()
      .then(async (data) => {
        if (!data?.user) return;
        setUser(data.user);
        setProfileState({
          name: data.user.name || '', address: data.user.address || '',
          phone: data.user.phone || '', email: data.user.email || '',
        });
        await AsyncStorage.setItem(AS_KEYS.user, JSON.stringify(data.user));
      })
      .catch(() => {});
  }, [token, hydrated]);

  // Push token registration
  useEffect(() => {
    if (!token || !hydrated) return;
    (async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;
        const tokenData = await Notifications.getExpoPushTokenAsync();
        if (tokenData?.data) await api.user.registerPushToken(tokenData.data).catch(() => {});
      } catch (_e) {}
    })();
  }, [token, hydrated]);

  // ── Cart ──────────────────────────────────────────────────────────────────
  const addToCart = useCallback((product, size, quantity) => {
    if (!size) return;
    setCart(prev => {
      const idx = prev.findIndex(i => i.productId === product.id && i.size === size);
      if (idx !== -1) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + quantity };
        return next;
      }
      return [...prev, {
        productId: product.id, name: product.name,
        price: product.price, image: product.image,
        size, quantity,
        storeId: product.storeId || null,
        storeName: product.storeName || null,
      }];
    });
  }, []);

  const updateCartQuantity = useCallback((productId, size, quantity) => {
    setCart(prev =>
      prev.map(i => i.productId === productId && i.size === size
        ? { ...i, quantity: Math.max(1, quantity) }
        : i,
      ).filter(i => i.quantity > 0),
    );
  }, []);

  const removeCartItem = useCallback((productId, size) => {
    setCart(prev => prev.filter(i => !(i.productId === productId && i.size === size)));
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  // ── Orders ────────────────────────────────────────────────────────────────
  const placeOrder = useCallback(async ({
    deliveryMode, timeSlot, subtotal, deliveryFee, total,
    pickupAddress, dropoffAddress,
    requestedDriverId, storeId,
    pickupLat, pickupLng, dropoffLat, dropoffLng,
  }) => {
    const orderData = {
      items:               cart,
      delivery_mode:       deliveryMode,
      time_slot:           timeSlot || 'ASAP',
      subtotal,
      delivery_fee:        deliveryFee,
      total,
      pickup_address:      pickupAddress  || 'Store Address',
      dropoff_address:     dropoffAddress || profile.address || 'Customer Address',
      preferred_driver_id: requestedDriverId || null,
      store_id:            storeId || null,
      pickup_lat:          pickupLat  || null,
      pickup_lng:          pickupLng  || null,
      dropoff_lat:         dropoffLat || null,
      dropoff_lng:         dropoffLng || null,
    };

    const data = await api.orders.create(orderData);
    setOrders(prev => [data.order, ...prev]);
    setCart([]);
    return data.order;
  }, [cart, profile.address]);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await api.orders.getAll();
      setOrders(data.orders);
    } catch (e) {
      console.warn('Failed to fetch orders', e);
    }
  }, []);

  const requestReturn = useCallback(async (orderId, reason) => {
    await api.orders.return(orderId, { reason });
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, return_requested: true } : o));
  }, []);

  // ── Context value ─────────────────────────────────────────────────────────
  const value = useMemo(() => ({
    loading: !hydrated,
    isAuthenticated,
    user,
    token,
    profile,
    updateProfile,
    setProfile: setProfileState,
    subscription,
    setSubscription,
    cart,
    addToCart,
    updateCartQuantity,
    removeCartItem,
    clearCart,
    placeOrder,
    fetchOrders,
    orders,
    requestReturn,
    products,
    statusSteps: STATUS_STEPS,
    login,
    register,
    loginWithApple,
    loginWithGoogle,
    acceptTermsAndAuthenticate,
    logout,
    handleSessionExpired,
  }), [
    hydrated, isAuthenticated, user, token, profile, subscription,
    cart, addToCart, updateCartQuantity, removeCartItem, clearCart,
    placeOrder, fetchOrders, orders, requestReturn, products,
    login, register, loginWithApple, loginWithGoogle,
    acceptTermsAndAuthenticate, logout, handleSessionExpired, updateProfile,
  ]);

  return <FlashContext.Provider value={value}>{children}</FlashContext.Provider>;
};

export const useFlash = () => {
  const ctx = useContext(FlashContext);
  if (!ctx) throw new Error('useFlash must be used within FlashProvider');
  return ctx;
};
