import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

/**
 * tasks/backgroundLocationTask.test.js
 *
 * Coverage-remediation Phase 6 — the driver app's location-update
 * handling: the real background task that keeps a customer's live order-
 * tracking map moving even while the driver's phone is locked or the app
 * is minimised (server side already covered in
 * tests/unit/driverLocation.test.js for the ETA/arrival-notification
 * logic this feeds). This is arguably the single most operationally
 * important piece of standalone logic in this app -- get it wrong and a
 * customer's tracking screen silently goes stale mid-delivery with
 * nothing in the UI to explain why. First real test this app has ever
 * had, alongside services/api.test.js.
 *
 * Real-world scenarios this file protects:
 *   - a real location ping arrives from the OS while backgrounded -> it
 *     is POSTed to the real /api/drivers/location endpoint with the real
 *     stored auth token (from SecureStore, not AsyncStorage -- this file's
 *     own header comment documents a real historical bug where the token
 *     was read from the wrong store and every ping silently no-opped) and
 *     the real active order id (from AsyncStorage)
 *   - the driver has logged out (no token) -> the ping is silently
 *     dropped, never sent unauthenticated
 *   - the OS reports a task error, or an empty location batch -> nothing
 *     is sent, and nothing crashes
 *   - going online under Expo Go (which cannot run background tasks at
 *     all) -> the app detects this and returns false immediately, rather
 *     than crashing the whole app at the native bridge layer (a real,
 *     previously-live bug this file's own header documents)
 *   - a real online-toggle flow: permissions requested in the right
 *     order, denial at any stage stops the flow cleanly, duplicate starts
 *     are no-ops, and going offline actually stops the real task
 */

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  Accuracy: { High: 'high' },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
}));
jest.mock('expo-constants', () => ({ appOwnership: null, executionEnvironment: null }));

// Required once, at module load -- TaskManager.defineTask() only ever runs
// once, the moment this file is first required (exactly like it does for
// real at app cold-start). The real handler passed to it is captured here
// so tests can invoke it directly, the same way the native bridge would
// when a real location arrives. (Re-requiring per test via
// jest.resetModules() would silently create a SECOND, different mocked
// expo-task-manager module instance than the one this file's own
// top-level `import * as TaskManager` already captured -- the same
// mismatch bug found and fixed in services/api.test.js.)
const taskModule = require('./backgroundLocationTask');
// Captured as plain values right after module load, before beforeEach's
// jest.clearAllMocks() ever runs -- that call wipes defineTask's recorded
// mock.calls (it only ever gets called once, at this module's own load
// time), so the "did it register correctly" assertion below reads these
// captured values instead of the live (post-clear) mock state.
const defineTaskCallArgs = TaskManager.defineTask.mock.calls[0];
const registeredCallback = defineTaskCallArgs[1];

beforeEach(() => {
  jest.clearAllMocks();
  Constants.appOwnership = null;
  Constants.executionEnvironment = null;
});

describe('the real background location task handler', () => {
  test('registers itself under the real, exported task name', () => {
    expect(defineTaskCallArgs[0]).toBe(taskModule.BACKGROUND_LOCATION_TASK);
    expect(typeof defineTaskCallArgs[1]).toBe('function');
  });

  test('a real location ping is POSTed with the real stored token and active order id', async () => {
    SecureStore.getItemAsync.mockResolvedValue('real-driver-token');
    AsyncStorage.getItem.mockResolvedValue('order-1');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await registeredCallback({ data: { locations: [{ coords: { latitude: -33.884, longitude: 25.585 } }] }, error: null });
    // The real POST is fire-and-forget (not awaited by the handler
    // itself) -- flush microtasks so it's actually issued before asserting.
    await new Promise((r) => setImmediate(r));

    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('FLASH_DRIVER_TOKEN');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://flash-app-hplc.onrender.com/api/drivers/location');
    expect(options.headers.Authorization).toBe('Bearer real-driver-token');
    expect(JSON.parse(options.body)).toEqual({ lat: -33.884, lng: 25.585, orderId: 'order-1' });
  });

  test('a ping with no real order id in progress omits orderId rather than sending a stale one', async () => {
    SecureStore.getItemAsync.mockResolvedValue('real-driver-token');
    AsyncStorage.getItem.mockResolvedValue(null);
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await registeredCallback({ data: { locations: [{ coords: { latitude: 1, longitude: 2 } }] }, error: null });
    await new Promise((r) => setImmediate(r));

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.orderId).toBeUndefined();
  });

  test('a driver with no stored token (logged out) never sends an unauthenticated ping', async () => {
    SecureStore.getItemAsync.mockResolvedValue(null);
    global.fetch = jest.fn();

    await registeredCallback({ data: { locations: [{ coords: { latitude: 1, longitude: 2 } }] }, error: null });
    await new Promise((r) => setImmediate(r));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an OS-reported task error sends nothing and does not throw', async () => {
    global.fetch = jest.fn();
    await expect(
      registeredCallback({ data: null, error: { message: 'location services disabled' } }),
    ).resolves.not.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an empty location batch sends nothing', async () => {
    global.fetch = jest.fn();
    await registeredCallback({ data: { locations: [] }, error: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('isExpoGoRuntime', () => {
  test('detects Expo Go via appOwnership', () => {
    Constants.appOwnership = 'expo';
    expect(taskModule.isExpoGoRuntime()).toBe(true);
  });

  test('detects Expo Go via executionEnvironment (storeClient)', () => {
    Constants.appOwnership = null;
    Constants.executionEnvironment = 'storeClient';
    expect(taskModule.isExpoGoRuntime()).toBe(true);
  });

  test('a real native/EAS build is not detected as Expo Go', () => {
    Constants.appOwnership = null;
    Constants.executionEnvironment = 'standalone';
    expect(taskModule.isExpoGoRuntime()).toBe(false);
  });
});

describe('startBackgroundLocation — the real online-toggle flow', () => {
  // Real-world scenario this specifically guards against (per this file's
  // own header comment): a driver going online under Expo Go used to take
  // the entire app down at the native bridge layer, with no catchable JS
  // error. This must short-circuit before any Location.* call at all.
  test('returns false immediately under Expo Go, without requesting any permission', async () => {
    Constants.appOwnership = 'expo';
    const result = await taskModule.startBackgroundLocation();
    expect(result).toBe(false);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  test('a real, successful online toggle requests permissions in order and starts the real task', async () => {
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    Location.startLocationUpdatesAsync.mockResolvedValue();

    const result = await taskModule.startBackgroundLocation();

    expect(result).toBe(true);
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalled();
    expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(
      taskModule.BACKGROUND_LOCATION_TASK,
      expect.objectContaining({ timeInterval: 10000, distanceInterval: 20 }),
    );
  });

  test('stops before requesting background permission when foreground permission is denied', async () => {
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const result = await taskModule.startBackgroundLocation();

    expect(result).toBe(false);
    expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test('does not start a second, duplicate task when one is already running', async () => {
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(true);

    const result = await taskModule.startBackgroundLocation();

    expect(result).toBe(true);
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});

describe('stopBackgroundLocation — the real offline-toggle / logout flow', () => {
  test('stops a real running task', async () => {
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    await taskModule.stopBackgroundLocation();
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(taskModule.BACKGROUND_LOCATION_TASK);
  });

  test('does nothing when no task is actually running', async () => {
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    await taskModule.stopBackgroundLocation();
    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});
