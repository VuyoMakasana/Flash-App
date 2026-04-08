import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { FlashProvider, useFlash } from './context/FlashContext';
import { View, ActivityIndicator } from 'react-native';

// ADDED: Sentry crash reporting for user app — catches crashes on real user devices
import * as Sentry from '@sentry/react-native';
if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN, environment: 'production' });
}

import HomeScreen from './screens/HomeScreen';
import ProfileScreen from './screens/ProfileScreen';
import ProductScreen from './screens/ProductScreen';
import CartScreen from './screens/CartScreen';
import CheckoutScreen from './screens/CheckoutScreen';
import PaymentScreen from './screens/PaymentScreen';
import OrdersScreen from './screens/OrdersScreen';
import OrderStatusScreen from './screens/OrderStatusScreen';
import TrackingScreen from './screens/TrackingScreen';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import SignUpScreen from './screens/SignUpScreen';
import TermsAndConditionsScreen from './screens/TermsAndConditionsScreen';
import SavedCardsScreen from './screens/SavedCardsScreen';
import SizingScreen from './screens/SizingScreen';
import FeedScreen from './screens/FeedScreen';
import ChatScreen from './screens/ChatScreen';
import TrustedDriversScreen from './screens/TrustedDriversScreen';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

const headerStyles = {
  headerStyle: { backgroundColor: '#0a0a0a' },
  headerTintColor: '#fff',
  headerTitleStyle: { fontWeight: '700', letterSpacing: 0.5 },
};

function ShopStack() {
  return (
    <Stack.Navigator screenOptions={headerStyles}>
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'FLASH' }} />
      <Stack.Screen name="Product" component={ProductScreen} options={{ title: 'Product' }} />
      <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Cart' }} />
      <Stack.Screen name="Checkout" component={CheckoutScreen} options={{ title: 'Checkout' }} />
      <Stack.Screen name="Payment" component={PaymentScreen} options={{ title: 'Payment' }} />
      <Stack.Screen name="OrderStatus" component={OrderStatusScreen} options={{ title: 'Order Status' }} />
      <Stack.Screen name="Tracking" component={TrackingScreen} options={{ title: 'Track Order' }} />
      <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'Message Driver' }} />
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
      <Stack.Screen name="Orders" component={OrdersScreen} options={{ title: 'Orders & Returns' }} />
      <Stack.Screen name="OrderStatus" component={OrderStatusScreen} options={{ title: 'Order Status' }} />
      <Stack.Screen name="Tracking" component={TrackingScreen} options={{ title: 'Track Order' }} />
      <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'Message Driver' }} />
    </Stack.Navigator>
  );
}

function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={headerStyles}>
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
      <Stack.Screen name="Orders" component={OrdersScreen} options={{ title: 'Orders' }} />
      <Stack.Screen name="SavedCards" component={SavedCardsScreen} options={{ title: 'Saved Cards' }} />
      <Stack.Screen name="Sizing" component={SizingScreen} options={{ title: 'Size Profile' }} />
      <Stack.Screen name="TrustedDrivers" component={TrustedDriversScreen} options={{ title: 'Trusted Drivers' }} />
    </Stack.Navigator>
  );
}

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Splash" component={SplashScreen} />
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="SignUp" component={SignUpScreen} />
      <Stack.Screen
        name="Terms"
        component={TermsAndConditionsScreen}
        options={{ headerShown: true, title: 'Terms & Conditions', ...headerStyles }}
      />
    </Stack.Navigator>
  );
}

function AppNavigator() {
  const { isAuthenticated, loading } = useFlash();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a' }}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {isAuthenticated ? (
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarIcon: ({ focused, color, size }) => {
              const icons = {
                Shop:    focused ? 'flash'          : 'flash-outline',
                Feed:    focused ? 'heart'          : 'heart-outline',
                Orders:  focused ? 'bag'            : 'bag-outline',
                Profile: focused ? 'person'         : 'person-outline',
              };
              return <Ionicons name={icons[route.name] || 'home-outline'} size={size} color={color} />;
            },
            tabBarActiveTintColor: '#0a0a0a',
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
