import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ToastProvider } from './components/ui.tsx'
import { SharePage } from './pages/share.tsx'
import './tokens.css'
import './fonts.css'
import './styles.css'
import './narrow.css'
import './share.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root 不存在')

// 對外分享頁不套內部外殼：直接由網址決定，不經過 App 的導航、側邊欄與操作入口。
const shareMatch = /^\/s\/([A-Za-z0-9_-]{20,128})\/?$/.exec(window.location.pathname)

createRoot(root).render(
  shareMatch ? (
    <SharePage token={shareMatch[1]!} />
  ) : (
    <ToastProvider>
      <App />
    </ToastProvider>
  ),
)
