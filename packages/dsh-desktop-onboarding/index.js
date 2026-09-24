/**
 * Host half of the DSH Desktop first-run onboarding notice.
 *
 * Registers the durable `desktop-onboarding` settings namespace that the
 * browser half uses to remember the user has already seen (and acknowledged)
 * the notice. The schema only carries the wizard version a release marks this
 * copy of the copy with, so re-releases can re-prompt by bumping the constant
 * the client compares against.
 *
 * The browser half (`./client.js`) does all the visible work — this file only
 * exists to claim the namespace before the settings mirror reads it.
 */
import z from '@deepseek-ai/schemastery'

const DESKTOP_ONBOARDING_NAMESPACE = 'desktop-onboarding'
const DesktopOnboardingSchema = z.object({
  wizardVersion: z.string()
})

export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      DESKTOP_ONBOARDING_NAMESPACE,
      DesktopOnboardingSchema
    )
  })
}