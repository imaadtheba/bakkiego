(async function () {
  // Only runs inside the Capacitor native wrapper (Android / iOS).
  // In a regular browser window.Capacitor is undefined — bail silently.
  if (!window.Capacitor || !window.Capacitor.isNativePlatform()) return;

  const { PushNotifications } = window.Capacitor.Plugins;
  if (!PushNotifications) return;

  // 1. Request permission
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return;

  // 2. Register device with FCM
  await PushNotifications.register();

  // 3. Save FCM token to Supabase users table for the logged-in user
  PushNotifications.addListener('registration', async ({ value: token }) => {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (!user?.id || !token) return;

    const { error } = await window.supabase
      .from('users')
      .update({ fcm_token: token })
      .eq('id', user.id);

    if (error) console.error('FCM token save failed:', error);
  });

  // Log registration errors for debugging
  PushNotifications.addListener('registrationError', (err) => {
    console.error('Push registration error:', err);
  });

  // 4. Handle notifications received while the app is in the foreground
  PushNotifications.addListener('pushNotificationReceived', (notification) => {
    console.log('Push notification received:', notification.title, notification.body);
  });

  // Handle tap on a notification (app in background / closed)
  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    console.log('Push notification tapped:', action.notification.title);
  });
})();
