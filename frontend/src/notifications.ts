export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyPermission(): NotifyPermission {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return Notification.permission as NotifyPermission;
  }
}

export function showNotification(
  title: string,
  body: string,
  options: { tag?: string; onClick?: () => void } = {}
) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return null;
  try {
    const n = new Notification(title, {
      body,
      tag: options.tag,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
    });
    if (options.onClick) {
      n.onclick = () => {
        window.focus();
        options.onClick?.();
        n.close();
      };
    }
    return n;
  } catch {
    return null;
  }
}
