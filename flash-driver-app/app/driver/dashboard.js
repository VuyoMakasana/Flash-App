import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, Alert, RefreshControl, ActivityIndicator, Vibration, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';
import driverApi, { BASE_URL } from '../../services/api';
import { io } from 'socket.io-client';
import * as Notifications from 'expo-notifications';

const STATUS_COLORS = {
  waiting_for_driver: '#f59e0b',
  driver_assigned: '#3b82f6',
  driver_arrived_store: '#8b5cf6',
  picked_up: '#ec4899',
  in_transit: '#8b5cf6',
  delivered: '#10b981',
};

const STATUS_LABELS = {
  waiting_for_driver: 'New Order',
  driver_assigned: 'Assigned',
  driver_arrived_store: 'At Store',
  picked_up: 'Picked Up',
  in_transit: 'In Transit',
  delivered: 'Delivered',
};

const NEXT_STATUS = {
  driver_assigned: 'driver_arrived_store',
  driver_arrived_store: 'picked_up',
  picked_up: 'in_transit',
  in_transit: 'delivered',
  delivered: 'completed',
};

const NEXT_LABEL = {
  driver_assigned: 'Arrived At Store',
  driver_arrived_store: 'Picked Up',
  picked_up: 'Mark In Transit',
  in_transit: 'Mark Delivered',
  delivered: 'Complete',
};

export default function DriverDashboard() {
  const { driver, token, isOnline, setOnline, logout } = useDriver();
  const router = useRouter();

  const [availableOrders, setAvailableOrders] = useState([]);
  const [activeOrder, setActiveOrder] = useState(null);
  const [earnings, setEarnings] = useState({ total: '0.00', orders: [], wallet: { wallet_balance: '0.00', pending_balance: '0.00' } });
  const [subscription, setSubscription] = useState(null);
  const [fleetAlerts, setFleetAlerts]       = useState([]);
  const [trustRequests, setTrustRequests]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [togglingOnline, setTogglingOnline] = useState(false);

  // FIX 5: New state for cash OTP flow — cash orders were getting permanently stuck at 'delivered' with no way to complete them
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
      const allOrders = data.orders || [];
      // Keep render bounded for mobile stability under high traffic spikes.
      setAvailableOrders(allOrders.slice(0, 50));
    } catch (_e) {
      // silently fail — subscription gate might block this
    }
  }, []);

  // ─── SOCKET SETUP ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_driver_pool');
      console.log('[Dashboard] Socket connected');
    });

    socket.on('new_order_available', (data) => {
      Vibration.vibrate([0, 200, 100, 200]);
      fetchAvailableOrders();
    });

    socket.on('fleet_alert', (alert) => {
      setFleetAlerts(prev => [alert, ...prev].slice(0, 3));
      Vibration.vibrate(300);
    });

    socket.on('trust_request', (req) => {
      setTrustRequests(prev => [req, ...prev]);
      Vibration.vibrate([0, 100, 50, 100]);
    });

    return () => socket.disconnect();
  }, [token, fetchAvailableOrders]);

  // ─── DATA LOADING ──────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    try {
      const [earningsRes, subRes, activeOrderRes] = await Promise.allSettled([
        driverApi.earnings.get(),
        driverApi.subscription.get(),
        driverApi.orders.getActive(),
      ]);

      if (earningsRes.status === 'fulfilled') {
        setEarnings({
          total: earningsRes.value.totalEarnings || '0.00',
          orders: earningsRes.value.orders || [],
          wallet: earningsRes.value.wallet || { wallet_balance: '0.00', pending_balance: '0.00' },
        });
      }

      if (subRes.status === 'fulfilled') {
        setSubscription(subRes.value.subscription || null);
      }

      if (activeOrderRes.status === 'fulfilled') {
        setActiveOrder(activeOrderRes.value.order || null);
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

    const registerPushToken = async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;

        const tokenData = await Notifications.getExpoPushTokenAsync();
        if (tokenData?.data) {
          await driverApi.notifications.registerToken(tokenData.data);
        }
      } catch (_e) {
        // Non-blocking: app should continue even if push registration fails.
      }
    };

    registerPushToken();
  }, [token]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  // ─── TOGGLE ONLINE ─────────────────────────────────────────────────────────
  const handleToggleOnline = async (val) => {
    if (!subscription && val) {
      Alert.alert(
        'Subscription Required',
        'You need an active plan to go online and accept deliveries.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Buy Plan', onPress: () => router.push('/driver/subscription') },
        ]
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

  // ─── ACCEPT ORDER ──────────────────────────────────────────────────────────
  const handleAcceptOrder = async (orderId) => {
    if (!subscription) {
      Alert.alert('No Active Plan', 'Purchase a delivery plan to accept orders.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Buy Plan', onPress: () => router.push('/driver/subscription') },
      ]);
      return;
    }
    try {
      const data = await driverApi.orders.acceptOrder(orderId);
      setActiveOrder(data.order);
      setAvailableOrders(prev => prev.filter(o => o.id !== orderId));
      await driverApi.subscription.incrementDelivery();
      Alert.alert('Order Accepted!', `Collect from: ${data.order.pickup_address}`);
    } catch (e) {
      Alert.alert('Failed', e.message);
    }
  };

  // ─── UPDATE ORDER STATUS ───────────────────────────────────────────────────
  const handleStatusUpdate = async () => {
    if (!activeOrder) return;
    const nextStatus = NEXT_STATUS[activeOrder.status];
    if (!nextStatus) return;
    try {
      await driverApi.orders.updateStatus(activeOrder.id, nextStatus);
      setActiveOrder(prev => ({ ...prev, status: nextStatus }));
      if (nextStatus === 'completed') {
        setActiveOrder(null);
        await loadAll();
        Alert.alert('Delivery Complete!', 'Great work! Ready for the next one.');
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  // FIX 5: Sends cash OTP to the customer — required for cash order completion
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

  // FIX 5: Confirms cash received using OTP — releases driver wallet balance and marks order completed
  const handleConfirmCash = async () => {
    if (!otpValue.trim()) {
      Alert.alert('Enter OTP', 'Please enter the OTP provided by the customer.');
      return;
    }
    setOtpLoading(true);
    try {
      await driverApi.payments.confirmCashReceived(activeOrder.id, otpValue.trim());
      setActiveOrder(null);
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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f59e0b" />}
    >
      {/* ── HEADER ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hey, {driver?.name?.split(' ')[0]} </Text>
          <Text style={styles.subGreeting}>
            {isOnline ? '🟢 You are online' : '⚫ You are offline'}
          </Text>
        </View>
        <View style={styles.headerActions}>
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

      {/* ── EARNINGS CARDS ── */}
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
            <View style={styles.addressRow}>
              <Ionicons name="storefront-outline" size={14} color="#9ca3af" />
              <Text style={styles.addressText} numberOfLines={1}>{activeOrder.pickup_address}</Text>
            </View>
            <View style={styles.addressRow}>
              <Ionicons name="location-outline" size={14} color="#f59e0b" />
              <Text style={styles.addressText} numberOfLines={1}>{activeOrder.dropoff_address}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.payoutText}>Earn: R{parseFloat(activeOrder.driver_payout || 0).toFixed(2)}</Text>
              {activeOrder.is_cash_delivery && (
                <Text style={styles.cashNote}>Collect delivery fee in cash</Text>
              )}
            </View>
            {NEXT_STATUS[activeOrder.status] && (
              <TouchableOpacity style={styles.actionBtn} onPress={handleStatusUpdate}>
                <Text style={styles.actionBtnText}>{NEXT_LABEL[activeOrder.status]}</Text>
              </TouchableOpacity>
            )}

            {/* FIX 5: Cash OTP UI — cash orders permanently stuck at delivered without this */}
            {activeOrder.is_cash_delivery && activeOrder.status === 'delivered' && (
              <View style={{ marginTop: 8, gap: 8 }}>
                {!otpRequested ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#f59e0b' }]}
                    onPress={handleRequestOtp}
                    disabled={otpLoading}
                  >
                    {otpLoading
                      ? <ActivityIndicator color="#0a0a0a" />
                      : <Text style={[styles.actionBtnText, { color: '#0a0a0a' }]}>Request Cash OTP</Text>
                    }
                  </TouchableOpacity>
                ) : (
                  <>
                    <TextInput
                      style={{
                        backgroundColor: '#1a1a1a',
                        borderWidth: 1,
                        borderColor: '#f59e0b',
                        borderRadius: 12,
                        padding: 14,
                        color: '#fff',
                        fontSize: 20,
                        fontWeight: '800',
                        textAlign: 'center',
                        letterSpacing: 8,
                      }}
                      placeholder="Enter OTP"
                      placeholderTextColor="#6b7280"
                      keyboardType="number-pad"
                      maxLength={6}
                      value={otpValue}
                      onChangeText={setOtpValue}
                    />
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: '#10b981' }]}
                      onPress={handleConfirmCash}
                      disabled={otpLoading}
                    >
                      {otpLoading
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={styles.actionBtnText}>Confirm Cash Received</Text>
                      }
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}
          </View>
        </View>
      )}

      {/* ── FLEET ALERTS ── */}
      {fleetAlerts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}> Demand Alerts</Text>
          {fleetAlerts.map((alert, i) => (
            <TouchableOpacity
              key={i}
              style={styles.alertCard}
              onPress={() => setFleetAlerts(prev => prev.filter((_, idx) => idx !== i))}
            >
              <Ionicons name="trending-up-outline" size={16} color="#f59e0b" />
              <Text style={styles.alertText} numberOfLines={2}>{alert.message}</Text>
              <Ionicons name="close" size={14} color="#6b7280" />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── TRUST REQUESTS (Part 4) ── */}
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
        {/* ADDED: Bank account shortcut — drivers need easy access to set up payouts */}
        <TouchableOpacity style={styles.quickBtn} onPress={() => router.push('/driver/bank')}>
          <Ionicons name="wallet-outline" size={22} color="#f59e0b" />
          <Text style={styles.quickBtnText}>Bank</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickBtn} onPress={() => router.push('/driver/profile')}>
          <Ionicons name="person-outline" size={22} color="#f59e0b" />
          <Text style={styles.quickBtnText}>Profile</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { paddingBottom: 40 },
  loadingContainer: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: '#9ca3af', fontSize: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 60 },
  greeting: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subGreeting: { color: '#9ca3af', fontSize: 13, marginTop: 2 },
  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: { padding: 6 },
  card: { margin: 16, marginTop: 0, backgroundColor: '#1a1a1a', borderRadius: 16, padding: 18 },
  cardOnline: { borderColor: '#f59e0b', borderWidth: 1 },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardSub: { color: '#9ca3af', fontSize: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subBanner: { marginHorizontal: 16, marginBottom: 12, backgroundColor: '#f59e0b', borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  subBannerText: { flex: 1, color: '#0a0a0a', fontWeight: '600', fontSize: 13 },
  subCard: { marginHorizontal: 16, marginBottom: 12, backgroundColor: '#0d2818', borderRadius: 12, padding: 14, borderColor: '#10b981', borderWidth: 1 },
  subCardText: { color: '#10b981', fontWeight: '600', fontSize: 14, marginLeft: 6, flex: 1 },
  subDeliveries: { color: '#9ca3af', fontSize: 12 },
  subExpiry: { color: '#6b7280', fontSize: 12, marginTop: 6, marginLeft: 26 },
  statsRow: { flexDirection: 'row', marginHorizontal: 16, gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14, alignItems: 'center' },
  statAmount: { color: '#f59e0b', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#9ca3af', fontSize: 11, marginTop: 4 },
  section: { marginHorizontal: 16, marginBottom: 16 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  orderCard: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, marginBottom: 12, gap: 10 },
  activeOrderCard: { borderColor: '#3b82f6', borderWidth: 1 },
  orderNum: { color: '#fff', fontWeight: '700', fontSize: 14, flex: 1 },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addressText: { color: '#9ca3af', fontSize: 13, flex: 1 },
  payoutText: { color: '#f59e0b', fontWeight: '700', fontSize: 15, flex: 1 },
  cashNote: { color: '#6b7280', fontSize: 11 },
  itemCount: { color: '#6b7280', fontSize: 12 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  cashBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#f59e0b', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  cashBadgeText: { color: '#0a0a0a', fontSize: 11, fontWeight: '800' },
  acceptBtn: { backgroundColor: '#f59e0b', borderRadius: 12, padding: 14, alignItems: 'center' },
  acceptBtnText: { color: '#0a0a0a', fontWeight: '800', fontSize: 15 },
  actionBtn: { backgroundColor: '#3b82f6', borderRadius: 12, padding: 14, alignItems: 'center' },
  actionBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  busyText: { color: '#6b7280', fontSize: 12, textAlign: 'center', paddingVertical: 8 },
  alertCard: { backgroundColor: '#1c1a0a', borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, borderColor: '#f59e0b', borderWidth: 1 },
  alertText: { flex: 1, color: '#fcd34d', fontSize: 13 },
  emptyCard: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, alignItems: 'center', gap: 10 },
  emptyText: { color: '#9ca3af', fontSize: 14, fontWeight: '500' },
  emptySubText: { color: '#4b5563', fontSize: 12 },
  quickActions: { flexDirection: 'row', marginHorizontal: 16, gap: 10 },
  quickBtn: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 14, padding: 16, alignItems: 'center', gap: 6 },
  quickBtnText: { color: '#9ca3af', fontSize: 12, fontWeight: '500' },

  // FIXED: OTP styles now INSIDE StyleSheet
  otpContainer: { marginTop: 12, backgroundColor: '#0d1e0d', borderRadius: 12, padding: 14, borderColor: '#10b981', borderWidth: 1 },
  otpTitle: { color: '#10b981', fontWeight: '700', fontSize: 14, marginBottom: 4 },
  otpSubtitle: { color: '#6b7280', fontSize: 12, marginBottom: 12 },
  otpInput: { backgroundColor: '#1a1a1a', borderRadius: 10, borderColor: '#374151', borderWidth: 1, color: '#fff', fontSize: 20, letterSpacing: 6, padding: 14, textAlign: 'center', marginBottom: 10 },
  otpBtnRow: { flexDirection: 'row', gap: 8 },
  otpBtn: { backgroundColor: '#f59e0b', borderRadius: 10, padding: 13, alignItems: 'center', justifyContent: 'center' },
  otpBtnText: { color: '#0a0a0a', fontWeight: '700', fontSize: 14 },
  otpConfirmBtn: { backgroundColor: '#10b981', borderRadius: 10, padding: 13, alignItems: 'center', justifyContent: 'center' },
  otpConfirmBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 }
});