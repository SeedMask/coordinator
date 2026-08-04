import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

// SwiftUI does not double-invoke lifecycle handlers; StrictMode breaks review .task parity.
createRoot(document.getElementById('root')!).render(<App />)
