import { useEffect, useState } from 'react'
import { shareApi, type ShareSnapshot } from '../lib/share-api.ts'
import { formatDateTime } from '../lib/format.ts'

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; snapshot: ShareSnapshot; expiresAt: string }

/**
 * 對外分享頁：不套內部外殼（沒有側邊欄、導航、分享與重跑入口），只渲染凍結快照。
 * 內容與內部 id 無關，頁面上也不會出現任何可寫操作。
 */
export function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    shareApi
      .read(token)
      .then((result) => alive && setState({ kind: 'ready', snapshot: result.snapshot, expiresAt: result.expiresAt }))
      .catch((error: unknown) => {
        if (!alive) return
        const status = (error as Error & { status?: number }).status
        setState({ kind: 'error', message: status === 404 ? '連結無效或已過期' : '讀取失敗，請稍後再試' })
      })
    return () => {
      alive = false
    }
  }, [token])

  if (state.kind === 'loading') {
    return (
      <div className="share-page">
        <div className="share-sheet share-state">正在讀取這份快照…</div>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="share-page">
        <div className="share-sheet share-state">
          <div className="share-state-title">{state.message}</div>
          <p className="share-state-text">這個連結可能已到期、已被建立者撤銷，或從未存在。請向發連結給你的人再要一份。</p>
        </div>
      </div>
    )
  }

  const { snapshot, expiresAt } = state

  return (
    <div className="share-page">
      <div className="share-banner">
        <span className="share-banner-dot" aria-hidden="true" />
        這是 {formatDateTime(snapshot.generatedAt)} 生成的只讀快照，之後的結果不會再更新
      </div>

      <main className="share-sheet">
        <div className="share-kicker">
          {snapshot.kindLabel} · {snapshot.title}
        </div>
        <h1 className="share-headline">{snapshot.headline}</h1>
        <p className="share-sample">{snapshot.sampleText}</p>

        <div className="share-stats">
          <div className="share-stat">
            <span>用例數</span>
            <b>{snapshot.totals.cases}</b>
          </div>
          {snapshot.branches.length === 1 ? (
            <div className="share-stat">
              <span>通過率</span>
              <b>{snapshot.passRateText}</b>
            </div>
          ) : (
            <div className="share-stat">
              <span>試驗次數</span>
              <b>{snapshot.trialCount}</b>
            </div>
          )}
          <div className="share-stat">
            <span>沒通過（各份合計）</span>
            <b className={snapshot.totals.failed > 0 ? 'share-neg' : undefined}>{snapshot.totals.failed}</b>
          </div>
          <div className="share-stat">
            <span>無法判斷</span>
            <b>{snapshot.totals.unknown}</b>
          </div>
        </div>

        {snapshot.branches.length > 1 && (
          <section className="share-section">
            <h2>{snapshot.branches.length} 份結果各自怎樣</h2>
            <div className="share-branches">
              {snapshot.branches.map((branch) => (
                <div className="share-branch" key={branch.name}>
                  <div className="share-branch-name">{branch.name}</div>
                  <div className="share-branch-headline">{branch.headline}</div>
                  <div className="share-branch-meta">
                    <span>通過率 {branch.passRateText}</span>
                    <span>平均回應 {branch.avgLatencyText}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="share-section">
          <h2>
            沒通過的 {snapshot.failuresTotal} 條
            {snapshot.failuresTotal > 0 && snapshot.evidenceListed < snapshot.failuresTotal
              ? `（這裡列出前 ${snapshot.evidenceListed} 條的期望與實際回答，其餘只列名稱）`
              : ''}
          </h2>
          {snapshot.failuresTotal === 0 ? (
            <p className="share-empty">這次沒有沒通過的用例。</p>
          ) : (
            <div className="share-failures">
              {snapshot.failures.map((failure, index) => (
                <article className="share-failure" key={`${failure.branchName}-${failure.caseName}-${index}`}>
                  <div className="share-failure-head">
                    <span className="share-failure-name">{failure.caseName}</span>
                    <span className="share-failure-owner">
                      {failure.branchName} · {failure.reason} · {failure.owner}
                    </span>
                  </div>
                  {failure.hint ? <div className="share-failure-hint">{failure.hint}</div> : null}
                  {failure.actual ? (
                    <div className="share-failure-body">
                      {failure.expected ? (
                        <div>
                          <span className="share-failure-label">期望</span>
                          {failure.expected}
                        </div>
                      ) : null}
                      <div>
                        <span className="share-failure-label">實際回答</span>
                        {failure.actual}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        {snapshot.unknownSummary.length > 0 && (
          <section className="share-section">
            <h2>為什麼有些條目無法判斷</h2>
            <ul className="share-unknown">
              {snapshot.unknownSummary.map((item) => (
                <li key={item.label}>
                  {item.label}：{item.cases} 條{item.hint ? `（${item.hint}）` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="share-foot">
          這是一份凍結的只讀快照，任何人在連結有效期內都能查看，不能修改或重新執行。連結到期（{formatDateTime(expiresAt)}）或被撤銷後立即失效。
        </footer>
      </main>
    </div>
  )
}
