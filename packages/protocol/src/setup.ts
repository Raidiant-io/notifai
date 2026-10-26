/**
 * Guided setup, as the CLI, the service and the browser setup pages all see
 * it. One spelling for each, so the notification the CLI sends and the one
 * the service sends for the browser are the same notification, and every
 * surface builds the same phone-step link.
 */

// ---------------------------------------------------------------------------
// Setup notification
// ---------------------------------------------------------------------------

/**
 * Collapse key of the Setup notification: the one-time notification that
 * says a computer is set up. The service recognizes the Setup notification
 * by it. Shipped CLIs already send this value, so it never changes.
 */
export const SETUP_NOTIFICATION_COLLAPSE_KEY = 'notifai-setup-verification' as const

/** The Setup notification's title, naming the computer that finished setup. */
export function setupNotificationTitle(machineName: string): string {
  return `${machineName} is set up`
}

/** The Setup notification's summary. */
export const SETUP_NOTIFICATION_SUMMARY = 'Your agents can reach you now.' as const

/**
 * `GET /api/v1/machine/setup-notification`, machine credential: when this
 * computer's Setup notification last went out in the past 24 hours, from this
 * computer or from the browser's setup page; null when it did not. Setup reads
 * it so the notification is sent only once.
 */
export interface MachineSetupNotificationResponse {
  sent_at: string | null
}

// ---------------------------------------------------------------------------
// The phone step's page: computer connected, no signed-in phone
// ---------------------------------------------------------------------------

/**
 * The browser setup page for a computer that is connected but has no
 * signed-in phone. It signs the phone in by QR, waits for notifications, asks
 * for a plan if needed, and sends the Setup notification when done.
 */
export const SETUP_PHONE_PATH = '/setup/phone' as const

/** The Account the computer belongs to, so a browser signed in elsewhere is caught. */
export const SETUP_PHONE_EMAIL_QUERY_PARAM = 'email' as const
/** The Approved Machine (`machine_id`) whose Setup notification the page sends. */
export const SETUP_PHONE_MACHINE_QUERY_PARAM = 'machine' as const
/** That computer's name, shown on the page only (never trusted for anything else). */
export const SETUP_PHONE_MACHINE_NAME_QUERY_PARAM = 'name' as const

/** The phone step's page on `dashboardOrigin`; empty or missing values are left out. */
export function setupPhoneUrl(
  dashboardOrigin: string,
  {
    email,
    machineId,
    machineName = null,
  }: { email: string | null; machineId: string | null; machineName?: string | null },
): string {
  const query = new URLSearchParams()
  if (email !== null && email !== '') query.set(SETUP_PHONE_EMAIL_QUERY_PARAM, email)
  if (machineId !== null && machineId !== '') query.set(SETUP_PHONE_MACHINE_QUERY_PARAM, machineId)
  const name = machineName?.trim() ?? ''
  if (name !== '') query.set(SETUP_PHONE_MACHINE_NAME_QUERY_PARAM, name)
  const search = query.toString()
  return `${dashboardOrigin.replace(/\/+$/, '')}${SETUP_PHONE_PATH}${search === '' ? '' : `?${search}`}`
}
