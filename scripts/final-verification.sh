echo "=== FIX 1: LAN IP CHECK ==="
grep -rn "100.66.43.71" flash-user-app/services/api.js flash-driver-app/services/api.js
echo "Result: if anything printed above, FIX 1 is NOT done"

echo "=== FIX 1: PRODUCTION URL CHECK ==="
grep -n "DEFAULT_BASE_URL" flash-user-app/services/api.js flash-driver-app/services/api.js

echo "=== FIX 2: GOOGLE MAPS KEYS ==="
grep -n "googleMapsApiKey\|apiKey" flash-user-app/app.json flash-driver-app/app.json
echo "Result: if YOUR_IOS or YOUR_ANDROID appears, FIX 2 is NOT done"

echo "=== FIX 3: DRIVER FIELD ==="
grep -n "requested_driver_id\|preferred_driver_id" flash-user-app/context/FlashContext.js
echo "Result: must show preferred_driver_id only"

echo "=== FIX 4: en_route ELIMINATED ==="
grep -rn "en_route" flash-user-app/screens/
echo "Result: if anything printed above, FIX 4 is NOT done"

echo "=== FIX 4: NEW STATUSES PRESENT ==="
grep -rn "driver_arrived_store\|in_transit" flash-user-app/screens/

echo "=== FIX 5: CASH OTP UI ==="
grep -n "otpRequested\|handleRequestOtp\|handleConfirmCash\|sendCashOtp\|confirmCashReceived" flash-driver-app/app/driver/dashboard.js
echo "Result: must show all 5 terms — if any missing, FIX 5 is NOT done"

echo "=== FIX 5: DRIVER API METHODS ==="
grep -n "sendCashOtp\|confirmCashReceived" flash-driver-app/services/api.js

echo "=== FIX 6: EXPO-NOTIFICATIONS INSTALLED ==="
grep "expo-notifications" flash-driver-app/package.json
echo "Result: must show expo-notifications — if nothing printed, FIX 6 is NOT done"

echo "=== FIX 6: EXPO-SERVER-SDK INSTALLED ==="
grep "expo-server-sdk" backend/package.json
echo "Result: must show expo-server-sdk — if nothing printed, FIX 6 is NOT done"

echo "=== FIX 6: PUSH SERVICE EXISTS ==="
ls backend/src/services/pushNotificationService.js
echo "Result: must show file path — if error, FIX 6 is NOT done"

echo "=== FIX 6: PUSH TOKEN ROUTE ==="
grep -n "push-token\|savePushToken" backend/src/routes/driverRoutes.js
echo "Result: must show the route — if nothing printed, FIX 6 is NOT done"

echo "=== FIX 6: PUSH TOKEN REGISTRATION IN CONTEXT ==="
grep -n "registerPushToken\|expo-notifications" flash-driver-app/context/DriverContext.js

echo "=== FIX 7: SIMULATED PAYOUT ELIMINATED ==="
grep -n "Simulated" backend/src/services/payoutService.js
echo "Result: if anything printed above, FIX 7 is NOT done"

echo "=== FIX 7: REAL TRANSFER METHODS ==="
grep -n "initiateTransfer\|createTransferRecipient" backend/src/services/paystackService.js
echo "Result: must show both methods — if missing, FIX 7 is NOT done"

echo "=== FIX 7: RECIPIENT CODE COLUMN ==="
grep -n "paystack_recipient_code" backend/src/db/migrate.js

echo "=== FIX 8: ENV VARS ==="
cat backend/.env | grep -E "JWT_SECRET|ADMIN_PASSWORD_HASH|PAYSTACK_SECRET_KEY|PAYFLEX_WEBHOOK_SECRET|APP_URL"
echo "Result: JWT_SECRET must not be flashsecretkey2024 — ADMIN_PASSWORD_HASH must not be blank — PAYSTACK must not be placeholder"

echo "=== FIX 8: PAYFLEX IDEMPOTENCY ==="
grep -n "event_id\|payflex_" backend/src/controllers/webhookController.js

echo "=== FIX 9: CANCELLATION PENALTY ==="
grep -n "cancellation_penalty\|0\.25\|penalty" backend/src/controllers/orderController.js
echo "Result: must show penalty logic — if nothing printed, FIX 9 is NOT done"

echo "=== FIX 9: PENALTY COLUMN IN MIGRATION ==="
grep -n "cancellation_penalty" backend/src/db/migrate.js
