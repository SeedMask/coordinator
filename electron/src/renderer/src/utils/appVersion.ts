/** Footer build label — matches Swift (Bundle CFBundleShortVersionString → v1.0.0). */
export function appBuildLabel(): string {
  const ver = import.meta.env.VITE_APP_VERSION || '1.0.1'
  return import.meta.env.DEV ? `v${ver} · dev` : `v${ver}`
}
