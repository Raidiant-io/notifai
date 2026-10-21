/**
 * A lifecycle notice that is due but not yet spent.
 *
 * A notice is shown at most once, so reading one used to record it as shown.
 * That spent notices nobody saw: activation that printed nothing, or context
 * that had no room for it. The caller now claims a notice only when the text
 * it is building has room for it, immediately before printing it. `claim`
 * re-checks under the notice's own lock and returns false when another session
 * showed it first.
 */
export interface PendingNotice {
  text: string
  claim: () => boolean
}

/** The text of a notice claimed now, for callers that always print what they read. */
export function claimNow(notice: PendingNotice | undefined): string | undefined {
  return notice !== undefined && notice.claim() ? notice.text : undefined
}
