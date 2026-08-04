import { AppProvider, useApp } from '@renderer/state/AppProvider'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { OneKeyPassphraseChoiceHost } from '@renderer/components/OneKeyPassphraseChoiceHost'
import { LoadingScreen } from '@renderer/views/LoadingScreen'
import { WelcomeView } from '@renderer/views/WelcomeView'
import { MainShellView } from '@renderer/views/MainShellView'

function AppRoot(): React.JSX.Element {
  const { ready, walletsBootstrapped, error, statusMessage, showWelcome, walletConfigured } = useApp()

  if (!ready || !walletsBootstrapped) {
    return <LoadingScreen error={error} statusMessage={statusMessage} />
  }

  if (showWelcome && !walletConfigured) {
    return (
      <>
        <WelcomeView />
        <OneKeyPassphraseChoiceHost />
      </>
    )
  }

  return (
    <>
      <MainShellView />
      <OneKeyPassphraseChoiceHost />
    </>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppRoot />
      </AppProvider>
    </ErrorBoundary>
  )
}
