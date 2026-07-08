// flash-user-app/App.js
// FULL REPLACEMENT FILE — adds ForgotPassword and ResetPassword screens to AuthStack.
// Every other line is identical to the original.
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar, ErrorUtils } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { FlashProvider, useFlash } from './context/FlashContext';
import { setSessionExpiredHandler } from './services/api';
import { View, ActivityIndicator } from 'react-native';

import * as Sentry from '@sentry/react-native';
if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN, environment: 'production' });
}

import HomeScreen               from './screens/HomeScreen';
import ProfileScreen            from './screens/ProfileScreen';
import ProductScreen            from './screens/ProductScreen';
import CartScreen               from './screens/CartScreen';
import CheckoutScreen           from './screens/CheckoutScreen';
import PaymentScreen            from './screens/PaymentScreen';
import OrdersScreen             from './screens/OrdersScreen';
import OrderStatusScreen        from './screens/OrderStatusScreen';
import TrackingScreen           from './screens/TrackingScreen';
import SplashScreen             from './screens/SplashScreen';
import LoginScreen              from './screens/LoginScreen';
import SignUpScreen             from './screens/SignUpScreen';
import TermsAndConditionsScreen from './screens/TermsAndConditionsScreen';
import SavedCardsScreen         from './screens/SavedCardsScreen';
import SizingScreen             from './screens/SizingScreen';
import FeedScreen               from './screens/FeedScreen';
import ChatScreen               from './screens/ChatScreen';
import TrustedDriversScreen     from './screens/TrustedDriversScreen';
import PrivacyPolicyScreen      from './screens/PrivacyPolicyScreen';
import StoreCreditsScreen       from './screens/StoreCreditsScreen';
// NEW: Password reset screens
import ForgotPasswordScreen     from './screens/ForgotPasswordScreen';
import ResetPasswordScreen      from './screens/ResetPasswordScreen';
// H8 FIX: these three screens existed but were never registered anywhere —
// Settings is the only screen with a "Delete Account" entry point.
import SettingsScreen           from './screens/SettingsScreen';
import AddressScreen            from './screens/AddressScreen';
import NotificationsScreen      from './screens/NotificationsScreen';

const Tab   = createBottomTabNavigator();
const Stack = createStackNavigator();

const headerStyles = {
  headerStyle:      { backgroundColor: '#0a0a0a' },
  headerTintColor:  '#fff',
  headerTitleStyle: { fontWeight: '700', letterSpacing: 0.5 },
};

function ShopStack() {
  return (
    <Stack.Navigator screenOptions={headerStyles}>
      <Stack.Screen name="Home"        component={HomeScreen}        options={{ title: 'FLASH' }} />
      <Stack.Screen name="Product"     component={ProductScreen}     options={{ title: 'Product' }} />
      <Stack.Screen name="Cart"        component={CartScreen}        options={{ title: 'Cart' }} />
      <Stack.Screen name="Checkout"    component={CheckoutScreen}    options={{ title: 'Checkout' }} />
      <Stack.Screen name="Payment"     component={PaymentScreen}     options={{ title: 'Payment' }} />
      <Stack.Screen name="OrderStatus" component={OrderStatusScreen} options={{ title: 'Order Status' }} />
      <Stack.Screen name="Tracking"    component={TrackingScreen}    options={{ title: 'Track Order' }} />
      <Stack.Screen name="Chat"        component={ChatScreen}        options={{ title: 'Message Driver' }} />
      {/* PaymentScreen's "Manage" saved-cards link navigates here — SavedCards
          otherwise only exists in ProfileStack, a sibling tab it can't reach. */}
      <Stack.Screen name="SavedCards"  component={SavedCardsScreen}  options={{ title: 'Saved Cards' }} />
    </Stack.Navigator>
  );
}

function FeedStack() {
  return (
    <Stack.Navigator screenOptions={headerStyles}>
      <Stack.Screen name="Feed" component={FeedScreen} options={{ title: 'Flash Feed' }} />
    </Stack.Navigator>
  );
}

function OrdersStack() {
  return (
    <Stack.Navigator screenOptions={headerStyles}>
      <Stack.Screen name="Orders"      component={OrdersScreen}      options={{ title: 'Orders & Returns' }} />
      <Stack.Screen name="OrderStatus" component={OrderStatusScreen} options={{ title: 'Order Status' }} />
      <Stack.Screen name="Tracking"    component={TrackingScreen}    options={{ title: 'Track Order' }} />
      <Stack.Screen name="Chat"        component={ChatScreen}        options={{ title: 'Message Driver' }} />
    </Stack.Navigator>
  );
}

function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={headerStyles}>
      <Stack.Screen name="Profile"        component={ProfileScreen}        options={{ title: 'Profile' }} />
      <Stack.Screen name="Orders"         component={OrdersScreen}         options={{ title: 'Orders' }} />
      {/* OrderStatus/Tracking/Chat are also registered in ShopStack and
          OrdersStack — OrdersScreen (reused here as Profile > Order History)
          navigates to all three, and React Navigation only resolves a route
          name against the current stack's own ancestor chain, not sibling
          tabs. Without these, tapping an order card or "Track Live" from
          Profile > Order History silently did nothing. */}
      <Stack.Screen name="OrderStatus"    component={OrderStatusScreen}    options={{ title: 'Order Status' }} />
      <Stack.Screen name="Tracking"       component={TrackingScreen}       options={{ title: 'Track Order' }} />
      <Stack.Screen name="Chat"           component={ChatScreen}           options={{ title: 'Message Driver' }} />
      <Stack.Screen name="SavedCards"     component={SavedCardsScreen}     options={{ title: 'Saved Cards' }} />
      <Stack.Screen name="Sizing"         component={SizingScreen}         options={{ title: 'Size Profile' }} />
      <Stack.Screen name="TrustedDrivers" component={TrustedDriversScreen} options={{ title: 'Trusted Drivers' }} />
      <Stack.Screen name="StoreCredits"   component={StoreCreditsScreen}   options={{ title: 'Store Credits', ...headerStyles }} />
      <Stack.Screen name="PrivacyPolicy"  component={PrivacyPolicyScreen}  options={{ title: 'Privacy Policy', ...headerStyles }} />
      {/* H8 FIX: Settings (with the only Delete Account entry point),
          Address, and Notifications were all fully built but never
          registered anywhere in the app. Each renders its own header
          (headerShown: false), matching how AuthStack's screens work. */}
      <Stack.Screen name="Settings"       component={SettingsScreen}       options={{ headerShown: false }} />
      <Stack.Screen name="Address"        component={AddressScreen}        options={{ headerShown: false }} />
      <Stack.Screen name="Notifications"  component={NotificationsScreen}  options={{ headerShown: false }} />
    </Stack.Navigator>
  );
}

// AuthStack now includes ForgotPassword and ResetPassword screens.
// headerShown: false on the stack so each screen controls its own header appearance.
// H9 FIX: 'Terms' no longer lives here — it's rendered as its own top-level
// gate in AppNavigator below (see needsTerms), since navigating to it
// manually from SignUpScreen raced against isAuthenticated flipping true
// and swapping this whole stack out before the user had a real chance to
// see it.
function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Splash"   component={SplashScreen} />
      <Stack.Screen name="Login"    component={LoginScreen} />
      <Stack.Screen name="SignUp"   component={SignUpScreen} />
      {/* Password reset — accessible from Login screen */}
      <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
      <Stack.Screen name="ResetPassword"  component={ResetPasswordScreen} />
    </Stack.Navigator>
  );
}

// H9 FIX: rendered instead of the authenticated tabs whenever a logged-in
// user hasn't accepted terms — the only route in this stack, with no way
// out except Accept (or Decline, which logs out via TermsAndConditionsScreen).
function TermsGateStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="Terms"
        component={TermsAndConditionsScreen}
        options={{ headerShown: true, title: 'Terms & Conditions', ...headerStyles }}
      />
    </Stack.Navigator>
  );
}

function AppNavigator() {
  const { isAuthenticated, loading, handleSessionExpired, user } = useFlash();
  const needsTerms = isAuthenticated && !user?.terms_accepted;

  // H-8 FIX: setSessionExpiredHandler is invoked directly by api.js's
  // request() the instant it detects an expired/revoked token —
  // unconditionally, before it even throws. The ErrorUtils hook stays as a
  // defensive fallback for the rare call site with no local try/catch;
  // the direct callback is what actually fires for the dominant pattern in
  // this app (screens wrapping api calls in a local catch, which swallows
  // the thrown error before it would ever reach ErrorUtils).
  React.useEffect(() => {
    setSessionExpiredHandler(handleSessionExpired);
    const originalHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      if (error?.message === 'SESSION_EXPIRED') {
        handleSessionExpired();
        return;
      }
      originalHandler(error, isFatal);
    });
    return () => ErrorUtils.setGlobalHandler(originalHandler);
  }, [handleSessionExpired]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a' }}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {needsTerms ? (
        <TermsGateStack />
      ) : isAuthenticated ? (
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarIcon: ({ focused, color, size }) => {
              const icons = {
                Shop:    focused ? 'flash'   : 'flash-outline',
                Feed:    focused ? 'heart'   : 'heart-outline',
                Orders:  focused ? 'bag'     : 'bag-outline',
                Profile: focused ? 'person'  : 'person-outline',
              };
              return <Ionicons name={icons[route.name] || 'home-outline'} size={size} color={color} />;
            },
            tabBarActiveTintColor:   '#0a0a0a',
            tabBarInactiveTintColor: '#9ca3af',
            tabBarStyle: { paddingBottom: 6, paddingTop: 6, height: 64, backgroundColor: '#fff', borderTopColor: '#e5e7eb' },
            tabBarLabelStyle: { fontWeight: '600' },
          })}
        >
          <Tab.Screen name="Shop"    component={ShopStack} />
          <Tab.Screen name="Feed"    component={FeedStack} />
          <Tab.Screen name="Orders"  component={OrdersStack} />
          <Tab.Screen name="Profile" component={ProfileStack} />
        </Tab.Navigator>
      ) : (
        <AuthStack />
      )}
      <StatusBar style={isAuthenticated ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <FlashProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['bottom']}>
          <AppNavigator />
        </SafeAreaView>
      </FlashProvider>
    </SafeAreaProvider>
  );
}
