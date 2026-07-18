import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, FlatList,
  Image, ScrollView, Alert, ActivityIndicator, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFlash } from '../context/FlashContext';
import api from '../services/api';

const TIME_SLOTS = ['ASAP', '10:00 - 12:00', '12:00 - 14:00', '17:00 - 19:00'];

// CHECKOUT PERSISTENCE: Key for saving checkout draft to AsyncStorage
// WHY: Users who kill the app mid-checkout lose their address and driver selection
// This restores their progress when they return
const CHECKOUT_DRAFT_KEY = 'FLASH_CHECKOUT_DRAFT';

export default function CheckoutScreen() {
  const navigation = useNavigation();
  const { cart, placeOrder, profile, updateProfile } = useFlash();

  const [deliveryMode, setDeliveryMode]     = useState('fleet');
  const [slot, setSlot]                     = useState('ASAP');
  const [loading, setLoading]               = useState(false);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [realDrivers, setRealDrivers]       = useState([]);
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  const [name, setName] = useState(profile.name || '');
  const [phone, setPhone] = useState(profile.phone || '');
  const [email, setEmail] = useState(profile.email || '');
  const [address, setAddress] = useState(profile.address || '');
  const [savedAddresses, setSavedAddresses] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState(null);

  const subtotal    = useMemo(() => cart.reduce((s, i) => s + i.price * i.quantity, 0), [cart]);
  const selectedDrv = realDrivers.find(d => d.id === selectedDriverId);
  const deliveryFee = useMemo(() => {
    if (!cart.length) return 0;
    // Pick-a-driver mode: use the fee the driver quoted (comes from Driver.getNearby)
    if (deliveryMode === 'pick' && selectedDrv) return selectedDrv.estimated_fee || 90;
    // Fleet mode: backend charges R90 (same mall) or R180 (different mall).
    // We default to R90 here — the actual fee is confirmed on the server and
    // returned in order.delivery_fee after the order is created.
    return 90;
  }, [cart.length, deliveryMode, selectedDrv]);
  const total = subtotal + deliveryFee;

  // Restore checkout draft on mount — recover state if app was killed mid-checkout
  useEffect(() => {
    const restoreDraft = async () => {
      try {
        const draft = await AsyncStorage.getItem(CHECKOUT_DRAFT_KEY);
        if (draft) {
          const parsed = JSON.parse(draft);
          if (parsed.name) setName(parsed.name);
          if (parsed.phone) setPhone(parsed.phone);
          if (parsed.email) setEmail(parsed.email);
          if (parsed.address) setAddress(parsed.address);
          if (parsed.slot) setSlot(parsed.slot);
          if (parsed.deliveryMode) setDeliveryMode(parsed.deliveryMode);
        }
      } catch (_) {}
    };
    restoreDraft();
  }, []);

  // Save checkout draft whenever form fields change
  // WHY: Persists state so user can recover if they kill the app
  useEffect(() => {
    const saveDraft = async () => {
      try {
        await AsyncStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify({
          name, phone, email, address, slot, deliveryMode,
        }));
      } catch (_) {}
    };
    saveDraft();
  }, [name, phone, email, address, slot, deliveryMode]);

  // ── Fetch saved addresses so the delivery-address field can be picked
  // instead of retyped every time (Home/Work/Other, per AddressScreen.js).
  // The typed/selected text is still just a label sent to the driver -
  // dropoff_lat/dropoff_lng always come from the device's live GPS position
  // below, unchanged, since this app has no address-to-coordinate geocoding.
  useEffect(() => {
    const loadSavedAddresses = async () => {
      try {
        const data = await api.user.getAddresses();
        const list = data.addresses || [];
        setSavedAddresses(list);
        const def = list.find(a => a.is_default);
        if (def && !address) {
          setAddress(def.full_address || def.street);
          setSelectedAddressId(def.id);
        }
      } catch (e) {
        // silently fall back — manual address entry still works fine
      }
    };
    loadSavedAddresses();
  }, []);

  const selectSavedAddress = (addr) => {
    setSelectedAddressId(addr.id);
    setAddress(addr.full_address || addr.street);
  };

  // ── Fetch real nearby drivers when user picks "pick a driver" ─────────────
  const fetchDrivers = useCallback(async () => {
    setLoadingDrivers(true);
    try {
      const data = await api.drivers.getNearby();
      setRealDrivers(data.drivers || []);
      if (data.drivers?.length) setSelectedDriverId(data.drivers[0].id);
    } catch (e) {
      // silently fall back — fleet mode still works fine
    } finally {
      setLoadingDrivers(false);
    }
  }, []);

  useEffect(() => {
    if (deliveryMode === 'pick') fetchDrivers();
  }, [deliveryMode, fetchDrivers]);

  const handleProceedToPayment = async () => {
    if (!cart.length) return;
    if (!name.trim() || !phone.trim() || !email.trim() || !address.trim()) {
      Alert.alert('Missing info', 'Please fill in name, phone, email and delivery address before continuing.');
      return;
    }
    if (deliveryMode === 'pick' && !selectedDriverId) {
      Alert.alert('Choose driver', 'Please select a driver or switch to Any Available Driver.');
      return;
    }

    setLoading(true);
    try {
      // Flash only delivers within Nelson Mandela Bay — the backend rejects
      // orders outside the service area, but it needs a real dropoff
      // coordinate to check against, not the typed address text alone
      // (there's no address-to-coordinate geocoding in this app). Uses the
      // customer's current device position as that coordinate, so this
      // assumes delivery to roughly where the customer is right now rather
      // than validating the specific typed address.
      const { status: existingStatus } = await Location.getForegroundPermissionsAsync();
      let permStatus = existingStatus;
      if (permStatus !== 'granted') {
        const req = await Location.requestForegroundPermissionsAsync();
        permStatus = req.status;
      }
      if (permStatus !== 'granted') {
        Alert.alert('Location needed', 'Please allow location access to confirm your delivery is within our service area.');
        setLoading(false);
        return;
      }
      const position = await Location.getCurrentPositionAsync({});

      await updateProfile({
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim().toLowerCase(),
        address: address.trim(),
      });

      const order = await placeOrder({
        deliveryMode,
        timeSlot:       slot,
        subtotal,
        deliveryFee,
        total,
        dropoffAddress: address.trim(),
        dropoffLat: position.coords.latitude,
        dropoffLng: position.coords.longitude,
        requestedDriverId: deliveryMode === 'pick' ? selectedDriverId : null,
      });
      // Clear checkout draft after successful order — no longer needed
      await AsyncStorage.removeItem(CHECKOUT_DRAFT_KEY).catch(() => {});
      navigation.navigate('Payment', {
        orderId: order.id,
        total,
        requestedDriverId: deliveryMode === 'pick' ? selectedDriverId : null,
      });
    } catch (err) {
      // Handle session expiry gracefully — don't show error, just redirect to login
      if (err.message === 'SESSION_EXPIRED') return;
      Alert.alert('Order Failed', err.message || 'Could not place order. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  if (!cart.length) {
    return (
      <View style={styles.empty}>
        <Ionicons name="bag-outline" size={48} color="#9ca3af" />
        <Text style={styles.emptyTitle}>Cart is empty</Text>
        <Text style={styles.emptyText}>Add items before checking out.</Text>
        <Pressable style={styles.cta} onPress={() => navigation.navigate('Home')}>
          <Text style={styles.ctaText}>Browse drops</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── Delivery Mode Toggle ──────────────────────────────────────────── */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Verification Details</Text>
        <TextInput
          style={styles.input}
          placeholder="Full name"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
        />
        <TextInput
          style={styles.input}
          placeholder="Phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />
        <TextInput
          style={styles.input}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        {savedAddresses.length > 0 && (
          <View style={styles.savedAddressRow}>
            {savedAddresses.map(addr => (
              <Pressable
                key={addr.id}
                style={[
                  styles.savedAddressChip,
                  selectedAddressId === addr.id && styles.savedAddressChipActive,
                ]}
                onPress={() => selectSavedAddress(addr)}
              >
                <Ionicons
                  name={addr.label === 'Home' ? 'home-outline' : addr.label === 'Work' ? 'briefcase-outline' : 'location-outline'}
                  size={14}
                  color={selectedAddressId === addr.id ? '#fff' : '#111827'}
                />
                <Text style={[
                  styles.savedAddressChipText,
                  selectedAddressId === addr.id && styles.savedAddressChipTextActive,
                ]}>
                  {addr.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          placeholder="Delivery address"
          value={address}
          onChangeText={(text) => { setAddress(text); setSelectedAddressId(null); }}
          multiline
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Delivery</Text>
        <View style={styles.toggleRow}>
          {['fleet', 'pick'].map(mode => (
            <Pressable
              key={mode}
              style={[styles.toggle, deliveryMode === mode && styles.toggleActive]}
              onPress={() => setDeliveryMode(mode)}
            >
              <Text style={[styles.toggleText, deliveryMode === mode && styles.toggleTextActive]}>
                {mode === 'fleet' ? 'Any Available Driver' : 'Pick a Driver'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* ── Auto-match mode (internal delivery_mode value stays 'fleet' —
             not renamed here; see backend/src/services/autoMatchService.js) ── */}
        {deliveryMode === 'fleet' && (
          <View style={styles.fleetCard}>
            <View>
              <Text style={styles.fleetTitle}>Any Available Driver</Text>
              <Text style={styles.fleetCopy}>Auto-assigns the nearest available driver.</Text>
            </View>
            <View style={styles.badge}>
              <Ionicons name="flash" size={14} color="#fff" />
              <Text style={styles.badgeText}>ASAP</Text>
            </View>
          </View>
        )}

        {/* ── Pick mode: real driver cards ─────────────────────────────── */}
        {deliveryMode === 'pick' && (
          loadingDrivers ? (
            <View style={styles.driverLoading}>
              <ActivityIndicator color="#0a0a0a" />
              <Text style={styles.driverLoadingText}>Finding nearby drivers...</Text>
            </View>
          ) : realDrivers.length === 0 ? (
            <View style={styles.noDrivers}>
              <Ionicons name="alert-circle-outline" size={24} color="#9ca3af" />
              <Text style={styles.noDriversText}>No drivers available right now. Try Any Available Driver.</Text>
            </View>
          ) : (
            <FlatList
              data={realDrivers}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={d => d.id}
              contentContainerStyle={{ gap: 12 }}
              renderItem={({ item: d }) => {
                const active = selectedDriverId === d.id;
                return (
                  <Pressable
                    style={[
                      styles.driverCard,
                      active && styles.driverActive,
                      d.is_busy && styles.driverBusy,
                    ]}
                    onPress={() => {
                      if (d.is_busy) {
                        Alert.alert(
                          'Driver Busy',
                          `${d.name} is currently completing another delivery.\n\nWould you like to wait or pick another driver?`,
                          [
                            { text: 'Wait', onPress: () => setSelectedDriverId(d.id) },
                            { text: 'Pick Another', style: 'cancel' },
                          ]
                        );
                        return;
                      }
                      setSelectedDriverId(d.id);
                    }}
                  >
                    {/* Profile photo or avatar */}
                    {d.profile_photo_url ? (
                      <Image source={{ uri: d.profile_photo_url }} style={styles.driverImg} />
                    ) : (
                      <View style={[styles.driverImg, styles.driverImgPlaceholder]}>
                        <Ionicons name="person" size={22} color="#9ca3af" />
                      </View>
                    )}

                    <View style={styles.driverNameRow}>
                      <Text style={[styles.driverName, active && styles.driverNameActive]} numberOfLines={1}>
                        {d.name}
                      </Text>
                      {/* Every driver in this list is already approved (see
                          Driver.getNearby's WHERE status = 'approved') */}
                      <Ionicons name="checkmark-circle" size={12} color={active ? '#a7f3d0' : '#10b981'} />
                    </View>
                    <Text style={[styles.driverMeta, active && styles.driverMetaActive]}>
                      {d.vehicle_type}{d.vehicle_plate ? ` (${d.vehicle_plate})` : ''}  •  {d.distance_km ? `${d.distance_km} km` : 'nearby'}
                    </Text>

                    {/* Rating + deliveries */}
                    <View style={styles.driverStats}>
                      <Ionicons name="star" size={11} color={active ? '#fbbf24' : '#f59e0b'} />
                      <Text style={[styles.driverStatText, active && { color: '#fef3c7' }]}>
                        {parseFloat(d.rating || 5).toFixed(1)}
                      </Text>
                      <Text style={[styles.driverStatSep, active && { color: '#6b7280' }]}>·</Text>
                      <Text style={[styles.driverStatText, active && { color: '#fef3c7' }]}>
                        {d.total_deliveries} trips
                      </Text>
                    </View>

                    {/* Fee */}
                    <Text style={[styles.driverFee, active && styles.driverFeeActive]}>
                      R{d.estimated_fee}
                    </Text>

                    {/* Busy overlay */}
                    {d.is_busy && (
                      <View style={styles.busyBadge}>
                        <Text style={styles.busyBadgeText}>Busy</Text>
                      </View>
                    )}

                    {active && !d.is_busy && (
                      <Ionicons name="checkmark-circle" size={18} color="#fff" style={styles.checkIcon} />
                    )}
                  </Pressable>
                );
              }}
            />
          )
        )}
      </View>

      {/* ── Time Slot ────────────────────────────────────────────────────── */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Delivery Time</Text>
        <View style={styles.slotRow}>
          {TIME_SLOTS.map(time => (
            <Pressable
              key={time}
              style={[styles.slot, slot === time && styles.slotActive]}
              onPress={() => setSlot(time)}
            >
              <Text style={[styles.slotText, slot === time && styles.slotTextActive]}>{time}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Order Summary ────────────────────────────────────────────────── */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Order Summary</Text>
        {cart.map(item => (
          <View key={`${item.productId}-${item.size}`} style={styles.orderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.orderMeta}>Size {item.size}  ×  {item.quantity}</Text>
            </View>
            <Text style={styles.orderPrice}>R{item.price * item.quantity}</Text>
          </View>
        ))}

        <View style={styles.divider} />
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal</Text>
          <Text style={styles.summaryValue}>R{subtotal}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Delivery</Text>
          <Text style={styles.summaryValue}>R{deliveryFee}</Text>
        </View>
        <View style={[styles.summaryRow, { marginTop: 4 }]}>
          <Text style={[styles.summaryLabel, styles.totalLabel]}>Total</Text>
          <Text style={[styles.summaryValue, styles.totalLabel]}>R{total}</Text>
        </View>

        <Pressable
          style={[styles.cta, loading && { opacity: 0.6 }]}
          onPress={handleProceedToPayment}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Text style={styles.ctaText}>Proceed to Payment</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#f7f7f7' },
  content:          { padding: 16, gap: 16, paddingBottom: 40 },
  card:             { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 12, elevation: 3 },
  input:            { backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: '#111827' },
  inputMultiline:   { minHeight: 72, textAlignVertical: 'top' },
  sectionTitle:     { fontWeight: '800', color: '#111827', fontSize: 18 },
  savedAddressRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  savedAddressChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
  savedAddressChipActive: { backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  savedAddressChipText: { fontSize: 13, fontWeight: '600', color: '#111827' },
  savedAddressChipTextActive: { color: '#fff' },
  toggleRow:        { flexDirection: 'row', gap: 10 },
  toggle:           { flex: 1, paddingVertical: 10, borderRadius: 12, backgroundColor: '#f3f4f6', alignItems: 'center' },
  toggleActive:     { backgroundColor: '#0a0a0a' },
  toggleText:       { fontWeight: '700', color: '#111827' },
  toggleTextActive: { color: '#fff' },
  fleetCard:        { backgroundColor: '#0a0a0a', padding: 16, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fleetTitle:       { color: '#fff', fontWeight: '800', fontSize: 16 },
  fleetCopy:        { color: '#d1d5db', marginTop: 4, fontSize: 12 },
  badge:            { backgroundColor: '#111827', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#374151' },
  badgeText:        { color: '#fff', fontWeight: '700' },
  driverLoading:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16 },
  driverLoadingText:{ color: '#9ca3af', fontWeight: '600' },
  noDrivers:        { alignItems: 'center', gap: 8, paddingVertical: 20 },
  noDriversText:    { color: '#9ca3af', textAlign: 'center' },
  driverCard:       { width: 150, backgroundColor: '#f9fafb', borderRadius: 16, padding: 12, borderWidth: 1.5, borderColor: '#e5e7eb', gap: 4, position: 'relative' },
  driverActive:     { backgroundColor: '#0a0a0a', borderColor: '#0a0a0a' },
  driverBusy:       { opacity: 0.7 },
  driverImg:        { width: 48, height: 48, borderRadius: 12, backgroundColor: '#e5e7eb', marginBottom: 4 },
  driverImgPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  driverNameRow:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  driverName:       { fontWeight: '800', color: '#111827', fontSize: 13 },
  driverNameActive: { color: '#fff' },
  driverMeta:       { color: '#6b7280', fontSize: 11 },
  driverMetaActive: { color: '#d1d5db' },
  driverStats:      { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  driverStatText:   { color: '#374151', fontSize: 11, fontWeight: '600' },
  driverStatSep:    { color: '#d1d5db', fontSize: 11 },
  driverFee:        { fontWeight: '800', color: '#111827', fontSize: 15, marginTop: 4 },
  driverFeeActive:  { color: '#fff' },
  busyBadge:        { position: 'absolute', top: 8, right: 8, backgroundColor: '#ef4444', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  busyBadgeText:    { color: '#fff', fontSize: 10, fontWeight: '700' },
  checkIcon:        { position: 'absolute', top: 8, right: 8 },
  slotRow:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slot:             { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: '#e5e7eb' },
  slotActive:       { backgroundColor: '#0a0a0a' },
  slotText:         { color: '#111827', fontWeight: '700' },
  slotTextActive:   { color: '#fff' },
  orderRow:         { flexDirection: 'row', alignItems: 'center', gap: 8 },
  orderName:        { fontWeight: '700', color: '#111827' },
  orderMeta:        { color: '#6b7280', fontSize: 12, marginTop: 2 },
  orderPrice:       { fontWeight: '800', color: '#111827' },
  divider:          { height: 1, backgroundColor: '#e5e7eb', marginVertical: 8 },
  summaryRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel:     { color: '#6b7280', fontWeight: '600' },
  summaryValue:     { color: '#111827', fontWeight: '700' },
  totalLabel:       { fontSize: 16, color: '#111827', fontWeight: '800' },
  cta:              { backgroundColor: '#0a0a0a', paddingVertical: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 },
  ctaText:          { color: '#fff', fontWeight: '800', fontSize: 16 },
  empty:            { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#f7f7f7', padding: 24 },
  emptyTitle:       { fontSize: 20, fontWeight: '800', color: '#0a0a0a' },
  emptyText:        { color: '#6b7280' },
});