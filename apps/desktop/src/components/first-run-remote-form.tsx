import { useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DesktopBackendAvailability } from '@/global'
import { useI18n } from '@/i18n'
import { deriveRemoteAuthProviderShape } from '@/lib/desktop-remote-auth'
import { AlertCircle, Check, Loader2, LogIn } from '@/lib/icons'
import { useRemoteConnectionSetup } from '@/lib/use-remote-connection-setup'

interface FirstRunRemoteFormProps {
  /** Return to the two-card setup choice. Omitted when there is no choice behind us. */
  onBack?: () => void
  /**
   * Which connection modes this artifact + machine offer (electron backend
   * registry). When the local mode is unavailable (light artifacts), this
   * form IS first-run setup — no back button, nothing behind it. Applying
   * still resumes the gated startup via the remote-applied path.
   */
  backends?: DesktopBackendAvailability[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Unknown error')
}

// The first-run skin over useRemoteConnectionSetup (Settings' gateway panel
// is the other). This surface: inline error/success rows, NO pre-save
// before oauth login (backing out must leave nothing persisted — config is
// written only on Apply), and Apply resumes the gated startup.
export function FirstRunRemoteForm({ backends, onBack }: FirstRunRemoteFormProps) {
  const { t } = useI18n()
  const copy = t.install
  const [remoteUrl, setRemoteUrl] = useState<string>('')
  const [remoteToken, setRemoteToken] = useState<string>('')
  const [applying, setApplying] = useState<boolean>(false)
  const [error, setError] = useState<null | string>(null)
  const [success, setSuccess] = useState<null | string>(null)

  const localModeOffered: boolean = backends
    ? (backends.find(entry => entry.mode === 'local')?.available ?? true)
    : true

  const setup = useRemoteConnectionSetup({
    copy: {
      enterUrlFirst: copy.enterUrlFirst,
      probeError: copy.probeError,
      signInIncomplete: copy.signInIncomplete
    },
    onError: (message: string) => {
      setSuccess(null)
      setError(message)
    },
    onInvalidate: () => {
      setError(null)
      setSuccess(null)
    },
    remoteToken,
    remoteUrl
  })

  const authProviderShape = deriveRemoteAuthProviderShape(setup.probe?.providers, copy.identityProvider)
  const { isPassword: isPasswordProvider, providerLabel } = authProviderShape

  const testRemote = async (): Promise<void> => {
    if (!setup.canTest) {
      setError(setup.authMode === 'oauth' ? copy.incompleteSignInTest : copy.incompleteTokenTest)

      return
    }

    setError(null)
    setSuccess(null)

    const tested = await setup.testRemote()

    if (tested) {
      setSuccess(copy.testSucceeded(tested.baseUrl, tested.version ?? undefined))
    }
  }

  const applyRemote = async (): Promise<void> => {
    if (!setup.canApply) {
      return
    }

    setApplying(true)
    setError(null)
    let applied = false

    try {
      await window.hermesDesktop.applyConnectionConfig(setup.payload())
      applied = true
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setApplying(false)
    }

    if (applied) {
      // Two-card flow: return to the chooser (main hides it via the
      // remote-applied resume). Remote-only flow: nothing to go back to —
      // the applied event tears this overlay down when startup resumes.
      onBack?.()
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 p-4 backdrop-blur-md">
      <div className="flex w-full max-w-xl flex-col rounded-xl border border-(--stroke-nous) bg-card p-8 shadow-nous">
        <div className="flex items-start gap-4">
          <BrandMark className="size-11 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{copy.remoteSetupTitle}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{copy.remoteSetupDesc}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{copy.remoteUrlTitle}</span>
            <Input
              autoComplete="url"
              disabled={applying}
              onChange={event => {
                setup.invalidateTest()
                setRemoteUrl(event.target.value)
              }}
              placeholder={copy.remoteUrlPlaceholder}
              value={remoteUrl}
            />
            <span className="text-xs text-muted-foreground">{copy.remoteUrlDesc}</span>
          </label>

          {setup.probeStatus === 'probing' ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {copy.probing}
            </div>
          ) : null}

          {setup.probeStatus === 'error' ? (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{setup.probe?.error || copy.probeError}</span>
            </div>
          ) : null}

          {setup.authResolved && setup.authMode === 'oauth' ? (
            <div className="rounded-md border border-(--ui-stroke-tertiary) p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{copy.authTitle}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {setup.oauthConnected ? copy.authSignedIn : copy.authNeedsOauth(providerLabel)}
                  </p>
                </div>
                {setup.oauthConnected ? (
                  <div className="flex items-center gap-1.5 text-sm text-primary">
                    <Check className="size-4" />
                    {copy.connected}
                  </div>
                ) : (
                  <Button disabled={setup.signingIn || applying} onClick={() => void setup.signIn()} size="sm">
                    {setup.signingIn ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
                    {isPasswordProvider ? copy.signIn : copy.signInWith(providerLabel)}
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          {setup.authResolved && setup.authMode === 'token' ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{copy.tokenTitle}</span>
              <Input
                autoComplete="off"
                disabled={applying}
                onChange={event => {
                  setup.invalidateTest()
                  setRemoteToken(event.target.value)
                }}
                placeholder={copy.pasteSessionToken}
                type="password"
                value={remoteToken}
              />
              <span className="text-xs text-muted-foreground">{copy.tokenDesc}</span>
            </label>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {success ? (
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check className="size-4" />
              <span>{success}</span>
            </div>
          ) : null}
        </div>

        <div
          className={
            localModeOffered
              ? 'mt-7 flex flex-wrap items-center justify-between gap-3'
              : 'mt-7 flex flex-wrap items-center justify-end gap-3'
          }
        >
          {localModeOffered ? (
            <Button disabled={applying} onClick={onBack} size="sm" variant="ghost">
              {copy.backToSetup}
            </Button>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              disabled={setup.testing || applying || !setup.canTest}
              onClick={() => void testRemote()}
              size="sm"
              variant="secondary"
            >
              {setup.testing ? <Loader2 className="size-4 animate-spin" /> : null}
              {copy.testConnection}
            </Button>
            <Button disabled={applying || !setup.canApply} onClick={() => void applyRemote()} size="sm">
              {applying ? <Loader2 className="size-4 animate-spin" /> : null}
              {copy.applyRemote}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
