// flash-driver-app/tasks/backgroundLocationTask.js
//
// PURPOSE:
//   Defines the Expo background location task that runs while the driver
//   app is minimised, the screen is locked, or Android kills the foreground
//   process. This file MUST be imported at the root of the app (_layout.js)
//   before any navigation occurs, so that the native side can register the
//   handler at cold-start. Importing it only inside a screen is not
//   sufficient and will cause the task to silently fail on Android.
//
// REQUIREMENTS:
//   expo-location  ~19.0.8   (already in package.json)
//   expo-task-manager          ← ADD TO PACKAGE.JSON (see instructions below)
//
// INSTALLATION:
//   npx expo install expo-task-manager
//   Then rebuild the native binary:  eas build --platform android
//   (Background tasks require a native build — Expo Go will not work)
//
// Android app.json already has ACCESS_BACKGROUND_LOCATION permission.
// iOS app.json already has NSLocationAlwaysAndWhenInUseUsageDescription.

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

export const BACKGROUND_LOCATION_TASK = 'FLASH_DRIVER_BACKGROUND_LOCATION';

// How often the OS delivers location updates (milliseconds).
// 10 000 ms == every ~10 seconds. Fine-grained enough for customer tracking,
// conservative enough to respect battery on long shifts.
const LOCATION_INTERVAL_MS = 10_000;

// Minimum movement before an update is delivered (metres).
const LOCATION_DISTANCE_METERS = 20;

// Backend URL — mirrors the pattern used in services/api.js
const DEFAULT_BASE_URL = 'https://flash-app-hplc.onrender.com';
const BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  process.env.REACT_NATIVE_API_BASE_URL ||
  DEFAULT_BASE_URL;

const TOKEN_KEY        = 'FLASH_DRIVER_TOKEN';
const ACTIVE_ORDER_KEY = 'FLASH_DRIVER_ACTIVE_ORDER_ID';

// ─── TASK DEFINITION ─────────────────────────────────────────────────────────
//
// TaskManager.defineTask MUST be called at module-level (not inside a
// function, hook, or effect). The native bridge calls this handler when a
// new location arrives, even when the app is fully backgrounded.

// CRITICAL FIX: this file's own header comment already documents
// "Background tasks require a native build — Expo Go will not work."
// defineTask() runs unconditionally at module load (required — see
// comment above), so if it throws in an environment without full native
// support, it takes the whole app down before anything else renders.
// Guarded defensively; background location genuinely won't work under
// Expo Go regardless, this only prevents a hard crash on load.
try {
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('[BG Location] Task error:', error.message);
    return;
  }

  if (!data?.locations?.length) return;

  const { latitude: lat, longitude: lng } = data.locations[0].coords;

  try {
    // The auth token lives in SecureStore (services/api.js's saveTokens),
    // not AsyncStorage — this task used to read it from AsyncStorage under
    // the same key name, which never matched anything after the token
    // storage was migrated to SecureStore, so `token` was always null here
    // and every background ping silently returned before ever POSTing.
    // SecureStore's native module calls work fine from a TaskManager
    // background callback (this task runs as a foreground service on
    // Android and a location-mode background context on iOS, both of which
    // keep the JS/native bridge alive) — only the active-order id, which is
    // written for exactly this purpose, stays in AsyncStorage.
    const [token, orderId] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      AsyncStorage.getItem(ACTIVE_ORDER_KEY),
    ]);

    if (!token) {
      // Driver logged out — nothing to do; the task will be stopped by
      // stopBackgroundLocation() called during logout.
      return;
    }

    // Fire-and-forget POST to the location endpoint.
    // We intentionally do not await the response to keep the background
    // handler fast. If the request fails, the next ping will compensate.
    fetch(`${BASE_URL}/api/drivers/location`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        lat,
        lng,
        orderId: orderId || undefined,
      }),
    }).catch((err) => {
      console.warn('[BG Location] POST failed:', err.message);
    });
  } catch (err) {
    console.warn('[BG Location] Storage read failed:', err.message);
  }
});
} catch (_) {}

// ─── START ───────────────────────────────────────────────────────────────────

/**
 * startBackgroundLocation()
 *
 * Call this when the driver toggles online.
 *
 * Handles:
 *  - permission request (always-on / background)
 *  - duplicate-start guard
 *  - Android battery optimisation disclaimer (shown by the OS automatically
 *    when ACCESS_BACKGROUND_LOCATION is requested on Android 10+)
 *
 * Returns true if started, false if permissions denied.
 */
export async function startBackgroundLocation() {
  try {
    // 1. Check / request foreground permission first (required before
    //    background permission can be requested on Android).
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      console.warn('[BG Location] Foreground permission denied');
      return false;
    }

    // 2. Request background permission.
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      console.warn('[BG Location] Background permission denied');
      return false;
    }

    // 3. Guard against duplicate registration.
    const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(
      BACKGROUND_LOCATION_TASK
    ).catch(() => false);

    if (alreadyRunning) {
      console.log('[BG Location] Task already running — skipping start');
      return true;
    }

    // 4. Start the task.
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: LOCATION_INTERVAL_MS,
      distanceInterval: LOCATION_DISTANCE_METERS,
      // showsBackgroundLocationIndicator: true renders the blue status-bar
      // indicator on iOS so the user knows location is active.
      showsBackgroundLocationIndicator: true,
      // foregroundService keeps the task alive on Android even when the
      // OS tries to kill the app to reclaim memory.
      foregroundService: {
        notificationTitle: 'Flash Delivery',
        notificationBody: 'Your location is being shared with customers.',
        notificationColor: '#f59e0b',
      },
      // pausesUpdatesAutomatically: false prevents iOS from pausing
      // location updates when the device is stationary.
      pausesUpdatesAutomatically: false,
    });

    console.log('[BG Location] Task started');
    return true;
  } catch (err) {
    console.error('[BG Location] startBackgroundLocation error:', err.message);
    return false;
  }
}

// ─── STOP ────────────────────────────────────────────────────────────────────

/**
 * stopBackgroundLocation()
 *
 * Call this when the driver toggles offline OR logs out.
 * Silently no-ops if the task is not running.
 */
export async function stopBackgroundLocation() {
  try {
    const isRunning = await Location.hasStartedLocationUpdatesAsync(
      BACKGROUND_LOCATION_TASK
    ).catch(() => false);

    if (isRunning) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      console.log('[BG Location] Task stopped');
    }
  } catch (err) {
    console.warn('[BG Location] stopBackgroundLocation error:', err.message);
  }
}