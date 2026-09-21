import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';
import { Text, Pressable } from 'react-native';

// Official mock, per @react-native-async-storage/async-storage's own docs
// (jest-expo's preset does not wire this in automatically).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { FlashProvider, useFlash } from './FlashContext';
import api from '../services/api';
import analytics from '../services/analytics';

/**
 * context/FlashContext.test.js
 *
 * Coverage-remediation Phase 6 — the user app's cart-to-order data shape:
 * placeOrder, the function that turns whatever is sitting in the cart
 * into the real payload api.orders.create sends to the backend (server
 * side already covered thoroughly in tests/integration/
 * orderCreation.test.js). First real test this app has ever had, along
 * with services/api.test.js.
 *
 * Real-world scenarios this file protects:
 *   - a customer with real items in their cart checks out -> the real
 *     cart array (productId/name/price/size/quantity/storeId/storeName
 *     per item, exactly what addToCart builds) is sent as `items`
 *     unmodified, and every other checkout field
 *     (delivery_mode/subtotal/total/etc.) is mapped to the real snake_case
 *     field names the backend's OrderController.createOrder actually
 *     destructures -- a silent field-name mismatch here would mean an
 *     order that looks fine in the app UI but arrives at the backend
 *     missing data
 *   - no dropoff address was explicitly passed for this checkout -> it
 *     falls back to the customer's real saved profile address, not a
 *     blank field
 *   - a real successful order clears the cart and hands back the created
 *     order; a real REJECTED order (e.g. the backend says out of stock)
 *     leaves the cart completely untouched, so the customer doesn't lose
 *     what they were buying just because checkout failed
 */

jest.mock('../services/api', () => ({
  __esModule: true,
  default: {
    auth: {
      acceptTerms: jest.fn(), appleSignIn: jest.fn(), googleSignIn: jest.fn(),
      login: jest.fn(), logout: jest.fn(), register: jest.fn(), setDateOfBirth: jest.fn(),
    },
    orders: { create: jest.fn(), getAll: jest.fn().mockResolvedValue({ orders: [] }), return: jest.fn() },
    // Real, unrelated effect FlashProvider fires once hydrated -- must
    // resolve cleanly or it crashes every test in this file regardless of
    // what's actually being tested (the checkout flow, not the product
    // catalogue fetch).
    products: { getAll: jest.fn().mockResolvedValue({ products: [] }) },
    user: {
      getProfile: jest.fn().mockResolvedValue({ user: {} }),
      registerPushToken: jest.fn().mockResolvedValue(),
      updateProfile: jest.fn(),
    },
  },
  saveTokens: jest.fn(),
  clearTokens: jest.fn(),
}));

jest.mock('../services/analytics', () => ({
  __esModule: true,
  default: { orderPlaced: jest.fn(), screenViewed: jest.fn() },
}));

const TEST_PRODUCT = { id: 'prod-1', name: 'Test Shirt', price: 199.99, image: 'x.jpg', storeId: 'store-1', storeName: 'Flash Closet' };

// A minimal real consumer -- exercises the context through its real
// public hook, the same way a real screen (HomeScreen/CheckoutScreen)
// would, rather than reaching into FlashProvider's internals directly.
function TestConsumer({ onOrderResult }) {
  const { cart, addToCart, placeOrder, setProfile } = useFlash();
  return (
    <>
      <Text testID="cart-length">{cart.length}</Text>
      <Pressable testID="add-to-cart" onPress={() => addToCart(TEST_PRODUCT, 'M', 2)} />
      <Pressable
        testID="set-profile-address"
        onPress={() => setProfile((p) => ({ ...p, address: '456 Profile Street' }))}
      />
      <Pressable
        testID="place-order"
        onPress={() =>
          placeOrder({
            deliveryMode: 'standard',
            subtotal: 399.98,
            deliveryFee: 90,
            total: 489.98,
            storeId: 'store-1',
            pickupLat: -33.884,
            pickupLng: 25.585,
            dropoffLat: -33.886,
            dropoffLng: 25.587,
          })
            .then((order) => onOrderResult({ order }))
            .catch((error) => onOrderResult({ error }))
        }
      />
    </>
  );
}

function renderWithProvider(onOrderResult = jest.fn()) {
  render(
    <FlashProvider>
      <TestConsumer onOrderResult={onOrderResult} />
    </FlashProvider>,
  );
  return onOrderResult;
}

describe('FlashContext.placeOrder — real cart-to-order data shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends the real cart array as items, and maps every field to the backend\'s real snake_case shape', async () => {
    api.orders.create.mockResolvedValue({ order: { id: 'order-1', order_number: 'FLASH-ABC' } });
    const onOrderResult = renderWithProvider();

    await act(async () => {
      fireEvent.press(screen.getByTestId('add-to-cart'));
    });
    await waitFor(() => expect(screen.getByTestId('cart-length').props.children).toBe(1));

    await act(async () => {
      fireEvent.press(screen.getByTestId('place-order'));
    });

    await waitFor(() => expect(api.orders.create).toHaveBeenCalled());
    const sentOrderData = api.orders.create.mock.calls[0][0];

    // The real cart item shape addToCart actually builds, sent unmodified.
    expect(sentOrderData.items).toEqual([
      { productId: 'prod-1', name: 'Test Shirt', price: 199.99, image: 'x.jpg', size: 'M', quantity: 2, storeId: 'store-1', storeName: 'Flash Closet' },
    ]);
    // Real field-name mapping to what OrderController.createOrder destructures.
    expect(sentOrderData.delivery_mode).toBe('standard');
    expect(sentOrderData.subtotal).toBe(399.98);
    expect(sentOrderData.delivery_fee).toBe(90);
    expect(sentOrderData.total).toBe(489.98);
    expect(sentOrderData.store_id).toBe('store-1');
    expect(sentOrderData.dropoff_lat).toBe(-33.886);
    expect(sentOrderData.dropoff_lng).toBe(25.587);
    expect(sentOrderData.time_slot).toBe('ASAP'); // real default when none given

    await waitFor(() => expect(onOrderResult).toHaveBeenCalledWith({ order: { id: 'order-1', order_number: 'FLASH-ABC' } }));
  });

  test('falls back to the customer\'s real saved profile address when no dropoff address is given', async () => {
    api.orders.create.mockResolvedValue({ order: { id: 'order-2' } });
    renderWithProvider();

    await act(async () => {
      fireEvent.press(screen.getByTestId('set-profile-address'));
      fireEvent.press(screen.getByTestId('add-to-cart'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('place-order'));
    });

    await waitFor(() => expect(api.orders.create).toHaveBeenCalled());
    expect(api.orders.create.mock.calls[0][0].dropoff_address).toBe('456 Profile Street');
  });

  test('a successful order clears the cart', async () => {
    api.orders.create.mockResolvedValue({ order: { id: 'order-3' } });
    renderWithProvider();

    await act(async () => {
      fireEvent.press(screen.getByTestId('add-to-cart'));
    });
    await waitFor(() => expect(screen.getByTestId('cart-length').props.children).toBe(1));

    await act(async () => {
      fireEvent.press(screen.getByTestId('place-order'));
    });

    await waitFor(() => expect(screen.getByTestId('cart-length').props.children).toBe(0));
  });

  test('a rejected order (e.g. real out-of-stock error) leaves the cart completely untouched', async () => {
    api.orders.create.mockRejectedValue(new Error('Test Shirt size M is out of stock'));
    const onOrderResult = renderWithProvider();

    await act(async () => {
      fireEvent.press(screen.getByTestId('add-to-cart'));
    });
    await waitFor(() => expect(screen.getByTestId('cart-length').props.children).toBe(1));

    await act(async () => {
      fireEvent.press(screen.getByTestId('place-order'));
    });

    await waitFor(() => expect(onOrderResult).toHaveBeenCalledWith({ error: expect.any(Error) }));
    // Still 1 -- the cart was never cleared because the order never succeeded.
    expect(screen.getByTestId('cart-length').props.children).toBe(1);
    expect(analytics.orderPlaced).not.toHaveBeenCalled();
  });
});
