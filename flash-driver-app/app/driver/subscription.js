import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, Linking, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import driverApi from '../../services/api';

// How long to keep polling the backend after the driver returns to the app
// before giving up and showing a manual "Check Again" state.
const CONFIRM_POLL_INTERVAL_MS = 3000;
const CONFIRM_POLL_MAX_ATTEMPTS = 5;

const PLANS = [
  {
    id: 'daily',
    label: 'Daily',
    price: 'R25',
    period: 'per day',
    deliveries: '10 deliveries',
    color: '#6b7280',
    icon: 'sunny-outline',
    features: ['10 delivery slots', 'Valid for 24 hours', 'All order types'],
  },
  {
    id: 'weekly',
    label: 'Weekly',
    price: 'R120',
    period: 'per week',
    deliveries: '60 deliveries',
    color: '#3b82f6',
    icon: 'calendar-outline',
    features: ['60 delivery slots', 'Valid for 7 days', 'All order types', 'Priority in pool'],
  },
  {
    id: 'monthly',
    label: 'Monthly',
    price: 'R350',
    period: 'per month',
    deliveries: 'Unlimited',
    color: '#f59e0b',
    icon: 'ribbon-outline',
    popular: true,
    features: ['Unlimited deliveries', 'Valid for 30 days', 'All order types', 'Priority matching', 'Cash order access'],
  },
  {
    id: 'quarterly',
    label: 'Quarterly',
    price: 'R900',
    period: 'per 3 months',
    deliveries: 'Unlimited',
    color: '#10b981',
    icon: 'trophy-outline',
    features: ['Unlimited deliveries', 'Valid 90 days', 'All order types', 'Top priority matching', 'Cash order access', 'Analytics dashboard'],
  },
];

export default function SubscriptionScreen() {
  const router = useRouter();
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(null);
  // Which plan we're waiting on backend confirmation for, after the driver
  // returns from the Paystack checkout browser. Distinct from `purchasing`,
  // which only covers the initial purchase-request call.
  const [confirmingPlanId, setConfirmingPlanId] = useState(null);

  // Tracks whether we're currently expecting a foreground return to trigger
  // a confirmation check — set right before opening the checkout URL, so the
  // AppState listener (registered once, for the screen's lifetime) knows
  // whether a background->active transition is actually a "returning from
  // Paystack" event or just an unrelated app switch.
  const pendingPlanIdRef = useRef(null);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    loadSubscription();
  }, []);

  const loadSubscription = async () => {
    try {
      const data = await driverApi.subscription.getCurrent();
      setSubscription(data.subscription);
      return data.subscription;
    } catch (e) {
      console.warn(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Re-checks the real subscription status from the backend rather than
  // assuming success just because the browser closed and the app regained
  // focus. Polls a few times (Paystack's webhook can take a few seconds to
  // land) before settling into a persistent "still confirming" state with a
  // manual retry — never a false "Plan Activated!", never a false failure.
  const confirmPurchase = useCallback(async (planId, attempt = 1) => {
    setConfirmingPlanId(planId);
    try {
      const data = await driverApi.subscription.getCurrent();
      const active = data.subscription;
      if (active && active.plan_type === planId) {
        setSubscription(active);
        setConfirmingPlanId(null);
        pendingPlanIdRef.current = null;
        Alert.alert('Plan Activated!', `Your ${planId} plan is now active.`, [
          { text: 'Start Driving', onPress: () => router.back() },
        ]);
        return;
      }
    } catch (e) {
      console.warn('[Subscription] confirmation check failed:', e.message);
    }

    if (attempt < CONFIRM_POLL_MAX_ATTEMPTS) {
      setTimeout(() => confirmPurchase(planId, attempt + 1), CONFIRM_POLL_INTERVAL_MS);
    }
    // else: leave confirmingPlanId set — the UI shows a persistent
    // "still confirming" card with a manual "Check Again" button instead of
    // silently giving up or claiming failure the payment may not have had.
  }, [router]);

  // Fires when the app returns to foreground after the driver was sent to
  // the system browser for Paystack checkout — this is the actual signal
  // we act on, not the Linking.openURL() call itself completing (which only
  // means the OS handed off to the browser, not that payment happened).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const cameToForeground =
        appStateRef.current.match(/inactive|background/) && nextState === 'active';
      appStateRef.current = nextState;

      if (cameToForeground && pendingPlanIdRef.current) {
        confirmPurchase(pendingPlanIdRef.current);
      }
    });
    return () => sub.remove();
  }, [confirmPurchase]);

  const handlePurchase = async (planId) => {
    const plan = PLANS.find(p => p.id === planId);
    Alert.alert(
      `Buy ${plan.label} Plan`,
      `${plan.price} will be charged via Paystack.\n\n${plan.features.join('\n')}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Pay ${plan.price}`,
          onPress: async () => {
            setPurchasing(planId);
            try {
              const data = await driverApi.subscription.purchase(planId);
              if (data.authorizationUrl) {
                const supported = await Linking.canOpenURL(data.authorizationUrl);
                if (!supported) {
                  Alert.alert('Error', 'Could not open the payment page.');
                  return;
                }
                pendingPlanIdRef.current = planId;
                await Linking.openURL(data.authorizationUrl);
              } else {
                Alert.alert('Payment Failed', data.message || 'Could not start payment.');
              }
            } catch (e) {
              Alert.alert('Payment Failed', e.message);
            } finally {
              setPurchasing(null);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#f59e0b" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Delivery Plans</Text>
        <View style={{ width: 40 }} />
      </View>

      <Text style={styles.subtitle}>
        Buy a plan to unlock delivery slots and start earning
      </Text>

      {/* Current plan */}
      {subscription && (
        <View style={styles.activePlanCard}>
          <Ionicons name="checkmark-circle" size={22} color="#10b981" />
          <View style={{ flex: 1 }}>
            <Text style={styles.activePlanTitle}>
              {subscription.plan_type.charAt(0).toUpperCase() + subscription.plan_type.slice(1)} Plan — Active
            </Text>
            {subscription.deliveries_limit && (
              <Text style={styles.activePlanDetail}>
                {subscription.deliveries_used} / {subscription.deliveries_limit} deliveries used
              </Text>
            )}
            <Text style={styles.activePlanDetail}>
              Expires {new Date(subscription.expires_at).toLocaleDateString('en-ZA')}
            </Text>
          </View>
        </View>
      )}

      {/* Payment confirmation in progress — shown after returning from the
          Paystack browser while we poll the backend for the real status,
          rather than assuming success just because the browser closed. */}
      {confirmingPlanId && (
        <View style={styles.confirmingCard}>
          <ActivityIndicator color="#f59e0b" size="small" />
          <View style={{ flex: 1 }}>
            <Text style={styles.confirmingTitle}>Confirming your payment…</Text>
            <Text style={styles.confirmingDetail}>
              This can take a few seconds after you finish paying in the browser.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.confirmingRetryBtn}
            onPress={() => confirmPurchase(confirmingPlanId)}
          >
            <Text style={styles.confirmingRetryText}>Check Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Plan cards */}
      {PLANS.map(plan => {
        const isActive = subscription?.plan_type === plan.id;
        const isPurchasing = purchasing === plan.id;

        return (
          <View key={plan.id} style={[styles.planCard, isActive && styles.planCardActive, plan.popular && styles.planCardPopular]}>
            {plan.popular && (
              <View style={styles.popularBadge}>
                <Text style={styles.popularText}>MOST POPULAR</Text>
              </View>
            )}
            <View style={styles.planHeader}>
              <View style={[styles.planIcon, { backgroundColor: plan.color + '20' }]}>
                <Ionicons name={plan.icon} size={22} color={plan.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.planLabel}>{plan.label}</Text>
                <Text style={styles.planDeliveries}>{plan.deliveries}</Text>
              </View>
              <View style={styles.priceBlock}>
                <Text style={[styles.planPrice, { color: plan.color }]}>{plan.price}</Text>
                <Text style={styles.planPeriod}>{plan.period}</Text>
              </View>
            </View>

            <View style={styles.featuresBlock}>
              {plan.features.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <Ionicons name="checkmark" size={14} color="#10b981" />
                  <Text style={styles.featureText}>{f}</Text>
                </View>
              ))}
            </View>

            {isActive ? (
              <View style={[styles.planBtn, styles.planBtnActive]}>
                <Ionicons name="checkmark-circle" size={16} color="#10b981" />
                <Text style={styles.planBtnActiveText}>Current Plan</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.planBtn, { backgroundColor: plan.color }]}
                onPress={() => handlePurchase(plan.id)}
                disabled={!!purchasing || !!confirmingPlanId}
              >
                {isPurchasing
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.planBtnText}>Buy {plan.label} Plan</Text>
                }
              </TouchableOpacity>
            )}
          </View>
        );
      })}

      <Text style={styles.footerNote}>
        Plans are charged once. No auto-renewal. Cancel any time by not renewing.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { paddingBottom: 40 },
  loadingContainer: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 60 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  subtitle: { color: '#9ca3af', fontSize: 14, marginHorizontal: 20, marginBottom: 20, lineHeight: 20 },
  activePlanCard: { marginHorizontal: 16, marginBottom: 16, backgroundColor: '#0d2818', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderColor: '#10b981', borderWidth: 1 },
  activePlanTitle: { color: '#10b981', fontWeight: '700', fontSize: 14 },
  activePlanDetail: { color: '#6b7280', fontSize: 12, marginTop: 3 },
  confirmingCard: { marginHorizontal: 16, marginBottom: 16, backgroundColor: '#2a1f0d', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderColor: '#f59e0b', borderWidth: 1 },
  confirmingTitle: { color: '#f59e0b', fontWeight: '700', fontSize: 14 },
  confirmingDetail: { color: '#9a8459', fontSize: 12, marginTop: 3 },
  confirmingRetryBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: '#f59e0b' },
  confirmingRetryText: { color: '#1a1200', fontWeight: '700', fontSize: 12 },
  planCard: { marginHorizontal: 16, marginBottom: 14, backgroundColor: '#1a1a1a', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: '#2a2a2a' },
  planCardActive: { borderColor: '#f59e0b' },
  planCardPopular: { borderColor: '#f59e0b' },
  popularBadge: { alignSelf: 'flex-start', backgroundColor: '#f59e0b', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 12 },
  popularText: { color: '#0a0a0a', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  planIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  planLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
  planDeliveries: { color: '#9ca3af', fontSize: 13, marginTop: 2 },
  priceBlock: { alignItems: 'flex-end' },
  planPrice: { fontSize: 22, fontWeight: '800' },
  planPeriod: { color: '#6b7280', fontSize: 11, marginTop: 2 },
  featuresBlock: { gap: 8, marginBottom: 18 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureText: { color: '#9ca3af', fontSize: 13 },
  planBtn: { borderRadius: 14, padding: 15, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  planBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  planBtnActive: { backgroundColor: '#0d2818', borderColor: '#10b981', borderWidth: 1 },
  planBtnActiveText: { color: '#10b981', fontWeight: '700', fontSize: 15 },
  footerNote: { color: '#4b5563', fontSize: 12, textAlign: 'center', marginHorizontal: 24, marginTop: 8, lineHeight: 18 },
});
