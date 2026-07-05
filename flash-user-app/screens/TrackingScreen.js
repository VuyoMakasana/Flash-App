import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator,
  Platform, Linking, Animated, Image, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import api, { BASE_URL } from '../services/api';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

// FIX 4: Align tracking labels with backend state machine values
// NOTE: these two maps also define `statuses` (Object.keys(STATUS_LABELS)),
// the ordered sequence rendered as progress steps below — 'cancelled' is
// deliberately NOT in here, since it's a terminal alternate state, not a
// step in the linear happy path. It's handled as a special case in the
// status-pill fallback and the steps-list render instead (see orderStatus
// === 'cancelled' below), so a cancellation racing in via socket update
// while this screen is open shows a clear cancelled state rather than the
// raw backend enum string or a corrupted step sequence.
const STATUS_LABELS = {
  paid:                 'Finding your driver...',
  driver_assigned:      'Driver assigned',
  driver_arrived_store: 'Driver is at the store',
  picked_up:            'Order picked up',
  in_transit:           'On the way to you',
  delivered:            'Delivered!',
  completed:            'Delivered!',
};

const STATUS_COLORS = {
  paid:                 '#f59e0b',
  driver_assigned:      '#3b82f6',
  driver_arrived_store: '#8b5cf6',
  picked_up:            '#f97316',
  in_transit:           '#8b5cf6',
  delivered:            '#10b981',
  completed:            '#16a34a',
};

export default function TrackingScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const { orderId, isCashDelivery } = route.params || {};

  const [orderStatus, setOrderStatus]       = useState('paid');
  const [driver, setDriver]                 = useState(null);
  const [driverLocation, setDriverLocation] = useState(null);
  const [loading, setLoading]               = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);
  // Arrival notification banner
  const [arrivalBanner, setArrivalBanner]   = useState(null);
  const [shownMilestones, setShownMilestones] = useState(new Set());
  // Cash reminder banner
  const [cashReminder, setCashReminder]     = useState(false);
  const [sosSending, setSosSending]         = useState(false);
  const [sosSent, setSosSent]               = useState(false);
  const bannerOpacity = useRef(new Animated.Value(0)).current;

  const socketRef = useRef(null);
  const mapRef    = useRef(null);

  // ── Show arrival banner with auto-dismiss ──────────────────────────────────
  const showBanner = useCallback((msg) => {
    setArrivalBanner(msg);
    bannerOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(bannerOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(4000),
      Animated.timing(bannerOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start(() => setArrivalBanner(null));
  }, [bannerOpacity]);

  // ── Dial button — opens phone dialler with masked number ──────────────────
  const handleCall = () => {
    // FIXED: Replaced fake placeholder number with real support number — customers tapping Call during a live delivery were reaching nothing
    Linking.openURL('tel:+27730849837').catch(() => {});
  };

  // ── Message button ────────────────────────────────────────────────────────
  const handleMessage = () => {
    navigation.navigate('Chat', { orderId });
  };

  // ── SOS / safety button ───────────────────────────────────────────────────
  // One tap, fires immediately — a safety feature needs to work under
  // stress, not make someone confirm a dialog first. Location is
  // best-effort: a missing/denied permission must never block the alert
  // itself from going through, since getting help matters more than having
  // an exact coordinate attached.
  const handleSOS = async () => {
    if (sosSending || sosSent) return;
    setSosSending(true);
    let lat, lng;
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') {
        const position = await Location.getCurrentPositionAsync({});
        lat = position.coords.latitude;
        lng = position.coords.longitude;
      }
    } catch (_) {
      // Proceed without location rather than block the alert.
    }

    try {
      await api.sos.trigger(orderId, lat, lng);
      setSosSent(true);
      Alert.alert('Help is on the way', 'Flash support has been notified with your order and location.');
    } catch (e) {
      Alert.alert(
        'Could not reach support',
        'If you are in immediate danger, please call emergency services directly. ' + (e.message || ''),
      );
    } finally {
      setSosSending(false);
    }
  };

  useEffect(() => {
    if (!orderId) return;

    const hydrateOrder = async () => {
      try {
        const data = await api.orders.getOrder(orderId);
        if (!data?.order) return;

        setOrderStatus(data.order.status || 'paid');
        if (data.order.driver_name) {
          setDriver({
            name: data.order.driver_name,
            vehicle: data.order.driver_vehicle,
            plate: data.order.driver_plate,
            phone: data.order.driver_phone,
            rating: data.order.driver_rating,
            photo: data.order.driver_photo,
            total_deliveries: data.order.driver_total_deliveries || 0,
            verified: data.order.driver_verification_status === 'approved',
          });
        }
        if (data.order.driver_lat && data.order.driver_lng) {
          setDriverLocation({ lat: data.order.driver_lat, lng: data.order.driver_lng });
        }
      } catch (_) {
        // Socket fallback will still keep tracking live updates.
      }
    };

    hydrateOrder();

    const connectSocket = async () => {
      const token = await AsyncStorage.getItem('FLASH_TOKEN');
      if (!token) return;

      const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setSocketConnected(true);
        socket.emit('track_order', { orderId });
        setLoading(false);
      });

      socket.on('disconnect', () => setSocketConnected(false));

      // Live driver location → update map marker
      socket.on('driver_location', (data) => {
        if (data.driverId) {
          setDriverLocation({ lat: data.lat, lng: data.lng });
          if (mapRef.current) {
            mapRef.current.animateToRegion({
              latitude:      parseFloat(data.lat),
              longitude:     parseFloat(data.lng),
              latitudeDelta:  0.012,
              longitudeDelta: 0.012,
            }, 600);
          }
        }
      });

      // Order status changed
      socket.on('order_update', (data) => {
        if (data.orderId === orderId) setOrderStatus(data.status);
      });

      // ── Arrival milestones from backend (Part 2) ─────────────────────────
      socket.on('arrival_update', (data) => {
        if (data.orderId !== orderId) return;
        // Deduplicate milestones within the session.
        setShownMilestones(prev => {
          if (prev.has(data.milestone)) return prev;
          const next = new Set(prev);
          next.add(data.milestone);
          showBanner(data.message);
          return next;
        });
      });

      // ── Cash reminder (Part 2) ────────────────────────────────────────────
      socket.on('cash_reminder', (data) => {
        if (data.orderId === orderId) setCashReminder(true);
      });

      socket.on('connect_error', () => {
        setLoading(false);
        // Fallback poll every 10s if socket fails
        const poll = async () => {
          try {
            const api = (await import('../services/api')).default;
            const data = await api.orders.getOrder(orderId);
            if (data?.order) {
              setOrderStatus(data.order.status);
              if (data.order.driver_name) {
                setDriver({
                  name:    data.order.driver_name,
                  vehicle: data.order.driver_vehicle,
                  plate:   data.order.driver_plate,
                  phone:   data.order.driver_phone,
                  rating:  data.order.driver_rating,
                  photo:   data.order.driver_photo,
                  total_deliveries: data.order.driver_total_deliveries || 0,
                  verified: data.order.driver_verification_status === 'approved',
                });
              }
            }
          } catch (_) {}
        };
        const timer = setInterval(poll, 10000);
        return () => clearInterval(timer);
      });
    };

    connectSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.emit('stop_tracking', { orderId });
        socketRef.current.disconnect();
      }
    };
  }, [orderId, showBanner]);

  const isCancelled = orderStatus === 'cancelled';
  const statusColor = isCancelled ? '#ef4444' : (STATUS_COLORS[orderStatus] || '#6b7280');
  const statusLabel = isCancelled ? 'Order cancelled' : (STATUS_LABELS[orderStatus] || orderStatus);
  const isCompleted = orderStatus === 'completed' || orderStatus === 'delivered';
  const statuses    = Object.keys(STATUS_LABELS);

  const defaultRegion = {
    latitude:      -33.9249,  // Port Elizabeth default
    longitude:      25.5858,
    latitudeDelta:  0.05,
    longitudeDelta: 0.05,
  };

  return (
    <View style={styles.container}>

      {/* ── MAP ─────────────────────────────────────────────────────────────── */}
      <View style={styles.mapContainer}>
        {Platform.OS !== 'web' ? (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFillObject}
            provider={PROVIDER_GOOGLE}
            initialRegion={defaultRegion}
            showsUserLocation
            showsMyLocationButton={false}
          >
            {driverLocation && (
              <Marker
                coordinate={{
                  latitude:  parseFloat(driverLocation.lat),
                  longitude: parseFloat(driverLocation.lng),
                }}
                title="Your Flash Driver"
                description={driver?.name || 'Driver'}
              >
                <View style={styles.driverMarker}>
                  <Ionicons name="bicycle" size={18} color="#fff" />
                </View>
              </Marker>
            )}
          </MapView>
        ) : (
          <View style={styles.mapPlaceholder}>
            <Ionicons name="map-outline" size={48} color="#6b7280" />
            <Text style={styles.mapPlaceholderText}>Map view on mobile</Text>
          </View>
        )}

        {/* Live indicator */}
        <View style={[styles.liveBadge, { backgroundColor: socketConnected ? '#16a34a' : '#f59e0b' }]}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{socketConnected ? 'Live' : 'Connecting...'}</Text>
        </View>

        {/* ── SOS button — one tap, fires immediately, always visible during
             an active delivery. Kept simple on purpose: a safety feature
             needs to work reliably under stress, not be feature-rich. ── */}
        {!isCancelled && (
          <Pressable
            style={[styles.sosBtn, sosSent && styles.sosBtnSent]}
            onPress={handleSOS}
            disabled={sosSending || sosSent}
          >
            {sosSending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name={sosSent ? 'checkmark-circle' : 'alert-circle'} size={16} color="#fff" />
                <Text style={styles.sosBtnText}>{sosSent ? 'Help Notified' : 'SOS'}</Text>
              </>
            )}
          </Pressable>
        )}

        {/* ── Arrival banner (Part 2) ────────────────────────────────────── */}
        {arrivalBanner && (
          <Animated.View style={[styles.arrivalBanner, { opacity: bannerOpacity }]}>
            <Ionicons name="location" size={16} color="#fff" />
            <Text style={styles.arrivalText}>{arrivalBanner}</Text>
          </Animated.View>
        )}
      </View>

      {/* ── PANEL ─────────────────────────────────────────────────────────── */}
      <View style={styles.panel}>

        {/* ── Cash reminder banner (Part 2) ─────────────────────────────── */}
        {!isCancelled && (isCashDelivery || cashReminder) && (
          <View style={styles.cashBanner}>
            <Ionicons name="cash-outline" size={18} color="#0a0a0a" />
            <Text style={styles.cashBannerText}>
              Please make sure that you have enough cash
            </Text>
          </View>
        )}

        {/* Status pill */}
        <View style={[styles.statusPill, { backgroundColor: statusColor }]}>
          <Ionicons name="flash" size={14} color="#fff" />
          <Text style={styles.statusPillText}>{statusLabel}</Text>
        </View>

        {/* Driver card with photo, name, rating + call/message buttons —
            customers previously only saw a moving map marker plus a generic
            person-icon placeholder; the backend already returned a photo
            URL (driver_photo) that nothing here ever read. */}
        {driver ? (
          <View style={styles.driverCard}>
            {driver.photo ? (
              <Image source={{ uri: driver.photo }} style={styles.driverAvatarImg} />
            ) : (
              <View style={styles.driverAvatar}>
                <Ionicons name="person" size={24} color="#fff" />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <View style={styles.driverNameRow}>
                <Text style={styles.driverName}>{driver.name}</Text>
                {driver.verified && (
                  <View style={styles.verifiedBadge}>
                    <Ionicons name="checkmark-circle" size={13} color="#10b981" />
                    <Text style={styles.verifiedBadgeText}>Verified</Text>
                  </View>
                )}
              </View>
              <Text style={styles.driverMeta}>
                {driver.vehicle}{driver.plate ? ` (${driver.plate})` : ''}  •  {parseFloat(driver.rating || 5).toFixed(1)}★  •  {driver.total_deliveries || 0} trips
              </Text>
            </View>
            {/* ── Part 2: Call button (masked dialler) ─────────────────── */}
            <Pressable style={styles.iconActionBtn} onPress={handleCall}>
              <Ionicons name="call" size={18} color="#0a0a0a" />
            </Pressable>
            {/* ── Part 2: Message button ────────────────────────────────── */}
            <Pressable style={[styles.iconActionBtn, { backgroundColor: '#0a0a0a' }]} onPress={handleMessage}>
              <Ionicons name="chatbubble-ellipses" size={16} color="#fff" />
            </Pressable>
          </View>
        ) : loading ? (
          <View style={styles.waitingCard}>
            <ActivityIndicator color="#0a0a0a" size="small" />
            <Text style={styles.waitingText}>Finding a driver nearby...</Text>
          </View>
        ) : null}

        {/* Progress steps — hidden for cancelled orders, where a linear
            "which step are we on" sequence doesn't apply; the status pill
            above already reads "Order cancelled" in that case. */}
        {!isCancelled && (
          <View style={styles.steps}>
            {statuses.map((key, idx) => {
              const currentIdx = statuses.indexOf(orderStatus);
              const done = idx <= currentIdx;
              return (
                <View key={key} style={styles.stepRow}>
                  <View style={[styles.stepDot, done && { backgroundColor: statusColor }]} />
                  <Text style={[styles.stepLabel, done && styles.stepLabelDone]}>
                    {STATUS_LABELS[key]}
                  </Text>
                  {done && <Ionicons name="checkmark-circle" size={16} color={statusColor} />}
                </View>
              );
            })}
          </View>
        )}

        {isCompleted && (
          <View style={styles.completedBanner}>
            <Ionicons name="checkmark-circle" size={20} color="#16a34a" />
            <Text style={styles.completedText}>Your order has been delivered! Enjoy 🎉</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#f7f7f7' },
  mapContainer:       { flex: 1, backgroundColor: '#e5e7eb' },
  mapPlaceholder:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  mapPlaceholderText: { color: '#9ca3af', fontWeight: '600' },
  driverMarker: {
    backgroundColor: '#0a0a0a', borderRadius: 20, padding: 8,
    borderWidth: 2, borderColor: '#fff',
  },
  liveBadge: {
    position: 'absolute', top: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
  },
  liveDot:  { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  liveText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  sosBtn: {
    position: 'absolute', top: 12, left: 12,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#dc2626',
  },
  sosBtnSent: { backgroundColor: '#16a34a' },
  sosBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  arrivalBanner: {
    position: 'absolute', bottom: 16, left: 16, right: 16,
    backgroundColor: '#1a1a1a', borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 12,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, elevation: 8,
  },
  arrivalText: { color: '#fff', fontWeight: '700', fontSize: 14, flex: 1 },
  panel: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 20, gap: 14,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 20, elevation: 10,
  },
  cashBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fef9c3', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: '#fde047',
  },
  cashBannerText: { color: '#0a0a0a', fontWeight: '600', fontSize: 13, flex: 1 },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
  },
  statusPillText: { color: '#fff', fontWeight: '800' },
  driverCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#f9fafb', borderRadius: 16, padding: 14,
  },
  driverAvatar: {
    width: 46, height: 46, borderRadius: 14,
    backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center',
  },
  driverAvatarImg: {
    width: 46, height: 46, borderRadius: 14, backgroundColor: '#e5e7eb',
  },
  driverNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  driverName:    { fontWeight: '800', color: '#111827' },
  driverMeta:    { color: '#6b7280', fontSize: 12, marginTop: 2 },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: '#ecfdf5', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  verifiedBadgeText: { color: '#10b981', fontSize: 10, fontWeight: '700' },
  iconActionBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center',
  },
  waitingCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#f9fafb', borderRadius: 16, padding: 14,
  },
  waitingText:    { color: '#6b7280', fontWeight: '600' },
  steps:          { gap: 10 },
  stepRow:        { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepDot:        { width: 10, height: 10, borderRadius: 5, backgroundColor: '#e5e7eb' },
  stepLabel:      { flex: 1, color: '#9ca3af', fontWeight: '600' },
  stepLabelDone:  { color: '#111827' },
  completedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#dcfce7', borderRadius: 14, padding: 14,
  },
  completedText: { color: '#15803d', fontWeight: '700', flex: 1 },
});
