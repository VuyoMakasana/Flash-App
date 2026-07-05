/**
 * flash-driver-app/app/driver/dashboard.js
 *
 * MEDIUM-1 FIX: Navigation buttons added to the active order card.
 *   Tapping "Navigate to Store" or "Navigate to Customer" opens Google Maps
 *   (or Apple Maps on iOS) with turn-by-turn directions using Linking.openURL.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, Alert, RefreshControl, ActivityIndicator,
  Vibration, TextInput, Platform, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';
import driverApi, { BASE_URL } from '../../services/api';
import { io } from 'socket.io-client';
import * as Notifications from 'expo-notifications';

const STATUS_COLORS = {
  waiting_for_driver:  '#f59e0b',
  driver_assigned:     '#3b82f6',
  driver_arrived_store:'#8b5cf6',
  picked_up:           '#ec4899',
  in_transit:          '#8b5cf6',
  delivered:           '#10b981',
};

const STATUS_LABELS = {
  waiting_for_driver:  'New Order',
  driver_assigned:     'Assigned',
  driver_arrived_store:'At Store',
  picked_up:           'Picked Up',
  in_transit:          'In Transit',
  delivered:           'Delivered',
};

const NEXT_STATUS = {
  driver_assigned:      'driver_arrived_store',
  driver_arrived_store: 'picked_up',
  picked_up:            'in_transit',
  in_transit:           'delivered',
  delivered:            'completed',
};

const NEXT_LABEL = {
  driver_assigned:      'Arrived At Store',
  driver_arrived_store: 'Picked Up Order',
  picked_up:            'Mark In Transit',
  in_transit:           'Mark Delivered',
  delivered:            'Complete',
};

// ── Navigation helpers (MEDIUM-1) ──────────────────────────────────────────
/**
 * Open Google Maps (Android) or Apple Maps (iOS) with turn-by-turn directions
 * to the given address string. Falls back to a web Google Maps URL if the
 * native apps are unavailable.
 */
function openNavigation(address) {
  if (!address) return;
  const encoded = encodeURIComponent(address);

  // Google Maps deep link works on Android and iOS (if Google Maps installed)
  const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`;
  // Apple Maps URL scheme (iOS only)
  const appleUrl  = `maps:0,0?daddr=${encoded}`;

  if (Platform.OS === 'ios') {
    // Try Apple Maps first on iOS
    Linking.openURL(appleUrl).catch(() => Linking.openURL(googleUrl).catch(() => {
      Alert.alert('Maps unavailable', 'Could not open a maps app on this device.');
    }));
  } else {
    Linking.openURL(googleUrl).catch(() => {
      Alert.alert('Maps unavailable', 'Could not open Google Maps on this device.');
    });
  }
}

export default function DriverDashboard() {
  // D2 FIX: activeOrder/setActiveOrder now come from DriverContext instead of
  // local state. The background location task reads the active order id from
  // AsyncStorage, which only the context's setActiveOrder() writes to — local
  // state here never persisted it, so live location pings never carried an
  // orderId and customers never saw driver movement during a delivery.
  const { driver, token, isOnline, setOnline, logout, activeOrder, setActiveOrder } = useDriver();
  const router = useRouter();

  const [availableOrders, setAvailableOrders] = useState([]);
  const [earnings, setEarnings]               = useState({
    total: '0.00',
    orders: [],
    wallet: { wallet_balance: '0.00', pending_balance: '0.00' },
  });
  const [subscription, setSubscription]   = useState(null);
  const [trustRequests, setTrustRequests] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [togglingOnline, setTogglingOnline] = useState(false);
  const [otpLoading, setOtpLoading]       = useState(false);
  const [otpRequested, setOtpRequested]   = useState(false);
  const [otpValue, setOtpValue]           = useState('');
  const socketRef = useRef(null);

  const toNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const fetchAvailableOrders = useCallback(async () => {
    try {
      const data = await driverApi.orders.getAvailable();
      setAvailableOrders((data.orders || []).slice(0, 50));
    } catch (_e) {}
  }, []);

  // ── Socket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_driver_pool');
    });

    socket.on('auth_expired', () => {
      socket.disconnect();
    });

    socket.on('join_driver_pool_denied', ({ reason }) => {
      Alert.alert('Account Pending', reason);
    });

    socket.on('new_order_available', () => {
      Vibration.vibrate([0, 200, 100, 200]);
      fetchAvailableOrders();
    });

    socket.on('trust_request', (req) => {
      setTrustRequests(prev => [req, ...prev]);
      Vibration.vibrate([0, 100, 50, 100]);
    });

    return () => socket.disconnect();
  }, [token, fetchAvailableOrders]);

  // ── Data loading ────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    try {
      const [earningsRes, subRes, activeOrderRes] = await Promise.allSettled([
        driverApi.earnings.getSummary(),
        driverApi.subscription.getCurrent(),
        driverApi.orders.getActive(),
      ]);

      if (earningsRes.status === 'fulfilled') {
        setEarnings({
          total:  earningsRes.value.totalEarnings || '0.00',
          orders: earningsRes.value.orders        || [],
          wallet: earningsRes.value.wallet        || { wallet_balance: '0.00', pending_balance: '0.00' },
        });
      }

      if (subRes.status === 'fulfilled') {
        setSubscription(subRes.value.subscription || null);
      }

      if (activeOrderRes.status === 'fulfilled') {
        await setActiveOrder(activeOrderRes.value.order || null);
      }

      await fetchAvailableOrders();
    } catch (e) {
      console.warn('Load failed:', e.message);
    } finally {
      setLoading(false);
    }
  }, [fetchAvailableOrders]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;
        const tokenData = await Notifications.getExpoPushTokenAsync();
        if (tokenData?.data) {
          await driverApi.driver.savePushToken(tokenData.data).catch(() => {});
        }
      } catch (_e) {}
    })();
  }, [token]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  // ── Online toggle ────────────────────────────────────────────────────────
  const handleToggleOnline = async (val) => {
    if (!subscription && val) {
      Alert.alert(
        'Subscription Required',
        'You need an active plan to go online and accept deliveries.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Buy Plan', onPress: () => router.push('/driver/subscription') },
        ],
      );
      return;
    }
    setTogglingOnline(true);
    try {
      await setOnline(val);
      if (socketRef.current) {
        socketRef.current.emit('driver_status', { online: val });
        if (val) socketRef.current.emit('join_driver_pool');
        else socketRef.current.emit('leave_driver_pool');
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setTogglingOnline(false);
    }
  };

  // ── Accept order ─────────────────────────────────────────────────────────
  const handleAcceptOrder = async (orderId) => {
    if (!subscription) {
      Alert.alert('No Active Plan', 'Purchase a delivery plan to accept orders.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Buy Plan', onPress: () => router.push('/driver/subscription') },
      ]);
      return;
    }
    try {
      const data = await driverApi.orders.accept(orderId);
      await setActiveOrder(data.order);
      setAvailableOrders(prev => prev.filter(o => o.id !== orderId));
      Alert.alert('Order Accepted!', `Collect from:\n${data.order.pickup_address}`);
    } catch (e) {
      Alert.alert('Failed', e.message);
    }
  };

  // ── Status update ─────────────────────────────────────────────────────────
  const handleStatusUpdate = async () => {
    if (!activeOrder) return;
    const nextStatus = NEXT_STATUS[activeOrder.status];
    if (!nextStatus) return;
    try {
      await driverApi.orders.updateStatus(activeOrder.id, nextStatus);
      if (nextStatus === 'completed') {
        await setActiveOrder(null);
        await loadAll();
        Alert.alert('Delivery Complete!', 'Great work! Ready for the next one.');
      } else {
        await setActiveOrder({ ...activeOrder, status: nextStatus });
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  // ── Cash OTP ──────────────────────────────────────────────────────────────
  const handleRequestOtp = async () => {
    setOtpLoading(true);
    try {
      await driverApi.payments.sendCashOtp(activeOrder.id);
      setOtpRequested(true);
      Alert.alert('OTP Sent', 'The customer has been sent a confirmation code.');
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not send OTP.');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleConfirmCash = async () => {
    if (!otpValue.trim()) {
      Alert.alert('Enter OTP', 'Please enter the OTP provided by the customer.');
      return;
    }
    setOtpLoading(true);
    try {
      await driverApi.payments.confirmCash(activeOrder.id, otpValue.trim());
      await setActiveOrder(null);
      setOtpRequested(false);
      setOtpValue('');
      await loadAll();
      Alert.alert('Payment Confirmed!', 'Cash collected. Delivery complete.');
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not confirm cash.');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: logout },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#f59e0b" />
        <Text style={styles.loadingText}>Loading dashboard...</Text>
      </View>
    );
  }

  const subscriptionExpired = !subscription;
  const todayEarnings = earnings.orders
    .filter(o => new Date(o.created_at).toDateString() === new Date().toDateString())
    .reduce((sum, o) => sum + toNumber(o.driver_payout, 0), 0);

  // Determine which address to show for navigation based on current status
  const navAddress = activeOrder
    ? ['driver_assigned', 'driver_arrived_store'].includes(activeOrder.status)
      ? activeOrder.pickup_address
      : activeOrder.dropoff_address
    : null;

  const navLabel = activeOrder
    ? ['driver_assigned', 'driver_arrived_store'].includes(activeOrder.status)
      ? 'Navigate to Store'
      : 'Navigate to Customer'
    : '';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f59e0b" />}
    >
      {/* ── HEADER ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hey, {driver?.name?.split(' ')[0]} 👋</Text>
          <Text style={styles.subGreeting}>
            {isOnline ? '🟢 You are online' : '⚫ You are offline'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => router.push('/driver/notifications')} style={styles.iconBtn}>
            <Ionicons name="notifications-outline" size={24} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/driver/profile')} style={styles.iconBtn}>
            <Ionicons name="person-circle-outline" size={28} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleLogout} style={styles.iconBtn}>
            <Ionicons name="log-out-outline" size={26} color="#9ca3af" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── ONLINE TOGGLE ── */}
      <View style={[styles.card, isOnline && styles.cardOnline]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{isOnline ? '🟢 Online — Taking Orders' : '⚫ Offline'}</Text>
            <Text style={styles.cardSub}>
              {subscriptionExpired
                ? 'Buy a plan to go online'
                : isOnline ? 'Tap to go offline' : 'Tap to start earning'}
            </Text>
          </View>
          {togglingOnline
            ? <ActivityIndicator color="#f59e0b" />
            : <Switch
                value={isOnline}
                onValueChange={handleToggleOnline}
                trackColor={{ false: '#374151', true: '#f59e0b' }}
                thumbColor="#fff"
              />
          }
        </View>
      </View>

      {/* ── SUBSCRIPTION BANNER ── */}
      {subscriptionExpired && (
        <TouchableOpacity style={styles.subBanner} onPress={() => router.push('/driver/subscription')}>
          <Ionicons name="warning-outline" size={18} color="#0a0a0a" />
          <Text style={styles.subBannerText}>No active plan — tap to subscribe and start earning</Text>
          <Ionicons name="chevron-forward" size={16} color="#0a0a0a" />
        </TouchableOpacity>
      )}
      {subscription && (
        <View style={styles.subCard}>
          <View style={styles.row}>
            <Ionicons name="checkmark-circle" size={20} color="#10b981" />
            <Text style={styles.subCardText}>
              {subscription.plan_type.charAt(0).toUpperCase() + subscription.plan_type.slice(1)} Plan Active
            </Text>
            {subscription.deliveries_limit && (
              <Text style={styles.subDeliveries}>
                {subscription.deliveries_used}/{subscription.deliveries_limit} deliveries
              </Text>
            )}
          </View>
          <Text style={styles.subExpiry}>
            Expires {new Date(subscription.expires_at).toLocaleDateString('en-ZA')}
          </Text>
        </View>
      )}

      {/* ── EARNINGS ── */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statAmount}>R{todayEarnings.toFixed(2)}</Text>
          <Text style={styles.statLabel}>Today</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statAmount}>R{earnings.total}</Text>
          <Text style={styles.statLabel}>All Time</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statAmount}>{earnings.orders.length}</Text>
          <Text style={styles.statLabel}>Deliveries</Text>
        </View>
      </View>
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statAmount}>R{toNumber(earnings.wallet?.pending_balance, 0).toFixed(2)}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statAmount}>R{toNumber(earnings.wallet?.wallet_balance, 0).toFixed(2)}</Text>
          <Text style={styles.statLabel}>Available</Text>
        </View>
      </View>

      {/* ── ACTIVE ORDER ── */}
      {activeOrder && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active Delivery</Text>
          <View style={[styles.orderCard, styles.activeOrderCard]}>
            <View style={styles.row}>
              <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[activeOrder.status] || '#374151' }]}>
                <Text style={styles.statusText}>{STATUS_LABELS[activeOrder.status] || activeOrder.status}</Text>
              </View>
              {activeOrder.is_cash_delivery && (
                <View style={styles.cashBadge}>
                  <Ionicons name="cash-outline" size={12} color="#0a0a0a" />
                  <Text style={styles.cashBadgeText}>CASH</Text>
                </View>
              )}
            </View>

            <Text style={styles.orderNum}>{activeOrder.order_number}</Text>

            {/* Pickup address */}
            <View style={styles.addressRow}>
              <Ionicons name="storefront-outline" size={14} color="#9ca3af" />
              <Text style={styles.addressText} numberOfLines={2}>{activeOrder.pickup_address}</Text>
            </View>

            {/* Dropoff address */}
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={14} color="#f59e0b" />
              <Text style={styles.addressText} numberOfLines={2}>{activeOrder.dropoff_address}</Text>
            </View>

            <View style={styles.row}>
              <Text style={styles.payoutText}>Earn: R{parseFloat(activeOrder.driver_payout || 0).toFixed(2)}</Text>
              {activeOrder.is_cash_delivery && (
                <Text style={styles.cashNote}>Collect cash from customer</Text>
              )}
            </View>

            {/* ── MEDIUM-1 FIX: Navigation button ── */}
            {navAddress && (
              <TouchableOpacity
                style={styles.navBtn}
                onPress={() => openNavigation(navAddress)}
                accessibilityLabel={navLabel}
              >
                <Ionicons name="navigate-outline" size={18} color="#0a0a0a" />
                <Text style={styles.navBtnText}>{navLabel}</Text>
              </TouchableOpacity>
            )}

            {/* Status advance button — hidden at 'delivered' only for cash
                orders, where the OTP block below takes over that step. A
                blanket `!== 'delivered'` here previously hid this button for
                EVERY order once delivered, including non-cash ones, which
                have no other way to reach 'completed' — a dead end for the
                majority of orders. */}
            {NEXT_STATUS[activeOrder.status] &&
              !(activeOrder.is_cash_delivery && activeOrder.status === 'delivered') && (
              <TouchableOpacity style={styles.actionBtn} onPress={handleStatusUpdate}>
                <Text style={styles.actionBtnText}>{NEXT_LABEL[activeOrder.status]}</Text>
              </TouchableOpacity>
            )}

            {/* Cash OTP flow */}
            {activeOrder.is_cash_delivery && activeOrder.status === 'delivered' && (
              <View style={styles.otpContainer}>
                <Text style={styles.otpTitle}>💵 Collect Cash Payment</Text>
                <Text style={styles.otpSubtitle}>Send the customer a one-time code, then enter it here to confirm you received cash.</Text>

                {!otpRequested ? (
                  <TouchableOpacity
                    style={styles.otpBtn}
                    onPress={handleRequestOtp}
                    disabled={otpLoading}
                  >
                    {otpLoading
                      ? <ActivityIndicator color="#0a0a0a" />
                      : <Text style={styles.otpBtnText}>Send Cash OTP to Customer</Text>
                    }
                  </TouchableOpacity>
                ) : (
                  <>
                    <TextInput
                      style={styles.otpInput}
                      placeholder="Enter 6-digit OTP"
                      placeholderTextColor="#6b7280"
                      keyboardType="number-pad"
                      maxLength={6}
                      value={otpValue}
                      onChangeText={setOtpValue}
                    />
                    <View style={styles.otpBtnRow}>
                      <TouchableOpacity
                        style={[styles.otpBtn, { flex: 1 }]}
                        onPress={handleRequestOtp}
                        disabled={otpLoading}
                      >
                        <Text style={styles.otpBtnText}>Resend OTP</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.otpConfirmBtn, { flex: 2 }]}
                        onPress={handleConfirmCash}
                        disabled={otpLoading}
                      >
                        {otpLoading
                          ? <ActivityIndicator color="#fff" />
                          : <Text style={styles.otpConfirmBtnText}>Confirm Cash Received</Text>
                        }
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </View>
            )}
          </View>
        </View>
      )}

      {/* ── TRUST REQUESTS ── */}
      {trustRequests.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Trust Requests</Text>
          {trustRequests.map((req, i) => (
            <View key={i} style={[styles.alertCard, { borderColor: '#10b981' }]}>
              <Ionicons name="person-add-outline" size={16} color="#10b981" />
              <Text style={[styles.alertText, { color: '#10b981', flex: 1 }]}>
                A customer wants to add you as a trusted driver
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  style={{ backgroundColor: '#10b981', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
                  onPress={async () => {
                    try {
                      await driverApi.trustedDrivers.respond(req.requestId, 'accept');
                      setTrustRequests(prev => prev.filter((_, idx) => idx !== i));
                    } catch (_) {}
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ backgroundColor: '#374151', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 }}
                  onPress={async () => {
                    try {
                      await driverApi.trustedDrivers.respond(req.requestId, 'decline');
                      setTrustRequests(prev => prev.filter((_, idx) => idx !== i));
                    } catch (_) {}
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ── AVAILABLE ORDERS ── */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            Available Orders {availableOrders.length > 0 && `(${availableOrders.length})`}
          </Text>
          <TouchableOpacity onPress={fetchAvailableOrders}>
            <Ionicons name="refresh" size={18} color="#f59e0b" />
          </TouchableOpacity>
        </View>

        {!isOnline ? (
          <View style={styles.emptyCard}>
            <Ionicons name="power-outline" size={32} color="#374151" />
            <Text style={styles.emptyText}>Go online to see available orders</Text>
          </View>
        ) : availableOrders.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="bag-outline" size={32} color="#374151" />
            <Text style={styles.emptyText}>No orders right now</Text>
            <Text style={styles.emptySubText}>Pull down to refresh</Text>
          </View>
        ) : (
          availableOrders.map(order => (
            <View key={order.id} style={styles.orderCard}>
              <View style={styles.row}>
                <Text style={styles.orderNum}>{order.order_number}</Text>
                {order.is_cash_delivery && (
                  <View style={styles.cashBadge}>
                    <Ionicons name="cash-outline" size={12} color="#0a0a0a" />
                    <Text style={styles.cashBadgeText}>CASH</Text>
                  </View>
                )}
              </View>
              <View style={styles.addressRow}>
                <Ionicons name="storefront-outline" size={14} color="#9ca3af" />
                <Text style={styles.addressText} numberOfLines={1}>{order.pickup_address}</Text>
              </View>
              <View style={styles.addressRow}>
                <Ionicons name="location-outline" size={14} color="#f59e0b" />
                <Text style={styles.addressText} numberOfLines={1}>{order.dropoff_address}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.payoutText}>
                  Earn R{toNumber(order.driver_payout, 0).toFixed(2)}
                </Text>
                <Text style={styles.itemCount}>
                  {order.item_count} item{order.item_count !== '1' ? 's' : ''}
                </Text>
              </View>
              {activeOrder ? (
                <Text style={styles.busyText}>Finish current delivery first</Text>
              ) : (
                <TouchableOpacity
                  style={styles.acceptBtn}
                  onPress={() => handleAcceptOrder(order.id)}
                >
                  <Text style={styles.acceptBtnText}>Accept Delivery</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </View>

      {/* ── QUICK ACTIONS ── */}
      <View style={styles.quickActions}>
        <TouchableOpacity style={styles.quickBtn} onPress={() => router.push('/driver/earnings')}>
          <Ionicons name="bar-chart-outline" size={22} color="#f59e0b" />
          <Text style={styles.quickBtnText}>Earnings</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={() => router.push('/driver/subscription')}>
          <Ionicons name="card-outline" size={22} color="#f59e0b" />
          <Text style={styles.quickBtnText}>My Plan</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={() => router.push('/driver/bank')}>
          <Ionicons name="wallet-outline" size={22} color="#f59e0b" />
          <Text style={styles.quickBtnText}>Bank</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={() => router.push('/driver/settings')}>
          <Ionicons name="settings-outline" size={22} color="#f59e0b" />
          <Text style={styles.quickBtnText}>Settings</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0a0a0a' },
  content:            { paddingBottom: 40 },
  loadingContainer:   { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText:        { color: '#9ca3af', fontSize: 14 },
  header:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 60 },
  greeting:           { color: '#fff', fontSize: 22, fontWeight: '700' },
  subGreeting:        { color: '#9ca3af', fontSize: 13, marginTop: 2 },
  headerActions:      { flexDirection: 'row', gap: 8 },
  iconBtn:            { padding: 6 },
  card:               { margin: 16, marginTop: 0, backgroundColor: '#1a1a1a', borderRadius: 16, padding: 18 },
  cardOnline:         { borderColor: '#f59e0b', borderWidth: 1 },
  cardTitle:          { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardSub:            { color: '#9ca3af', fontSize: 12, marginTop: 4 },
  row:                { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subBanner:          { marginHorizontal: 16, marginBottom: 12, backgroundColor: '#f59e0b', borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  subBannerText:      { flex: 1, color: '#0a0a0a', fontWeight: '600', fontSize: 13 },
  subCard:            { marginHorizontal: 16, marginBottom: 12, backgroundColor: '#0d2818', borderRadius: 12, padding: 14, borderColor: '#10b981', borderWidth: 1 },
  subCardText:        { color: '#10b981', fontWeight: '600', fontSize: 14, marginLeft: 6, flex: 1 },
  subDeliveries:      { color: '#9ca3af', fontSize: 12 },
  subExpiry:          { color: '#6b7280', fontSize: 12, marginTop: 6, marginLeft: 26 },
  statsRow:           { flexDirection: 'row', marginHorizontal: 16, gap: 10, marginBottom: 16 },
  statCard:           { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14, alignItems: 'center' },
  statAmount:         { color: '#f59e0b', fontSize: 18, fontWeight: '800' },
  statLabel:          { color: '#9ca3af', fontSize: 11, marginTop: 4 },
  section:            { marginHorizontal: 16, marginBottom: 16 },
  sectionHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle:       { color: '#fff', fontSize: 16, fontWeight: '700' },
  orderCard:          { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, marginBottom: 12, gap: 10 },
  activeOrderCard:    { borderColor: '#3b82f6', borderWidth: 1 },
  orderNum:           { color: '#fff', fontWeight: '700', fontSize: 14, flex: 1 },
  addressRow:         { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  addressText:        { color: '#9ca3af', fontSize: 13, flex: 1 },
  payoutText:         { color: '#f59e0b', fontWeight: '700', fontSize: 15, flex: 1 },
  cashNote:           { color: '#6b7280', fontSize: 11 },
  itemCount:          { color: '#6b7280', fontSize: 12 },
  statusBadge:        { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusText:         { color: '#fff', fontSize: 12, fontWeight: '600' },
  cashBadge:          { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#f59e0b', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  cashBadgeText:      { color: '#0a0a0a', fontSize: 11, fontWeight: '800' },
  // MEDIUM-1 FIX: Navigation button
  navBtn:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#f59e0b', borderRadius: 12, padding: 14, marginTop: 4 },
  navBtnText:         { color: '#0a0a0a', fontWeight: '800', fontSize: 15 },
  acceptBtn:          { backgroundColor: '#f59e0b', borderRadius: 12, padding: 14, alignItems: 'center' },
  acceptBtnText:      { color: '#0a0a0a', fontWeight: '800', fontSize: 15 },
  actionBtn:          { backgroundColor: '#3b82f6', borderRadius: 12, padding: 14, alignItems: 'center' },
  actionBtnText:      { color: '#fff', fontWeight: '800', fontSize: 15 },
  busyText:           { color: '#6b7280', fontSize: 12, textAlign: 'center', paddingVertical: 8 },
  alertCard:          { backgroundColor: '#1c1a0a', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, borderColor: '#f59e0b', borderWidth: 1 },
  alertText:          { flex: 1, color: '#fcd34d', fontSize: 13 },
  emptyCard:          { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, alignItems: 'center', gap: 10 },
  emptyText:          { color: '#9ca3af', fontSize: 14, fontWeight: '500' },
  emptySubText:       { color: '#4b5563', fontSize: 12 },
  quickActions:       { flexDirection: 'row', marginHorizontal: 16, gap: 10 },
  quickBtn:           { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14, alignItems: 'center', gap: 6 },
  quickBtnText:       { color: '#9ca3af', fontSize: 11, fontWeight: '500' },
  otpContainer:       { marginTop: 8, backgroundColor: '#0d1e0d', borderRadius: 12, padding: 14, borderColor: '#10b981', borderWidth: 1, gap: 10 },
  otpTitle:           { color: '#10b981', fontWeight: '700', fontSize: 14 },
  otpSubtitle:        { color: '#6b7280', fontSize: 12 },
  otpInput:           { backgroundColor: '#1a1a1a', borderRadius: 10, borderColor: '#374151', borderWidth: 1, color: '#fff', fontSize: 20, letterSpacing: 6, padding: 14, textAlign: 'center' },
  otpBtnRow:          { flexDirection: 'row', gap: 8 },
  otpBtn:             { backgroundColor: '#f59e0b', borderRadius: 10, padding: 13, alignItems: 'center', justifyContent: 'center' },
  otpBtnText:         { color: '#0a0a0a', fontWeight: '700', fontSize: 14 },
  otpConfirmBtn:      { backgroundColor: '#10b981', borderRadius: 10, padding: 13, alignItems: 'center', justifyContent: 'center' },
  otpConfirmBtnText:  { color: '#fff', fontWeight: '700', fontSize: 14 },
});
