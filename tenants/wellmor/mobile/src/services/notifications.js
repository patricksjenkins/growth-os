/**
 * WellMor Push Notification Service
 * Handles Expo push notification registration and display.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { API_BASE_URL } from '../constants/config';
import { getAccessToken } from './supabase';

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Register for push notifications and return the token
 */
export async function registerForPushNotifications() {
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Push notification permission not granted');
    return null;
  }

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;
    console.log('Push token:', token);
    await registerTokenWithBackend(token);
    return token;
  } catch (err) {
    console.log('Push notifications not available (expected in Expo Go):', err.message);
    return null;
  }
}

/**
 * Send the push token to our backend with JWT auth
 */
async function registerTokenWithBackend(pushToken) {
  try {
    const jwt = await getAccessToken();
    if (!jwt) return;

    await fetch(`${API_BASE_URL}/api/notifications/register-device`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        token: pushToken,
        platform: Platform.OS,
        device_name: Device.deviceName,
      }),
    });
  } catch (err) {
    // Non-critical — notifications will just not work
    console.warn('Failed to register push token with backend:', err);
  }
}

/**
 * Set up notification response handler (when user taps a notification)
 */
export function setupNotificationResponseHandler(navigation) {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const data = response.notification.request.content.data;

    if (data?.type === 'approval_request' && data?.post_id) {
      navigation.navigate('PendingPosts', {
        screen: 'PostDetail',
        params: { postId: data.post_id },
      });
    } else if (data?.type === 'post_published' && data?.post_id) {
      navigation.navigate('PostedHistory', {
        screen: 'PostDetail',
        params: { postId: data.post_id },
      });
    }
  });

  return subscription;
}

/**
 * Clear the badge count
 */
export async function clearBadge() {
  return Notifications.setBadgeCountAsync(0);
}
